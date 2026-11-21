import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { jobsEnabled } from '../jobs/jobs-config.js';
import { currentEnrollmentWhere } from '../common/access.service.js';
import {
  NotificationInput,
  NotificationsService,
} from './notifications.service.js';

/** "1500.00" -> "₹1,500". */
const rupees = (value: Prisma.Decimal | string | number) =>
  Number(value).toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

/** "5:30 pm" in India time. */
const shortTime = (date: Date) =>
  date.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Student timetable link for a class (the query keeps links unique per class for de-duplication). */
const classLink = (id: bigint) => `/student/classes?class=${id}`;

const shortDate = (date: Date) =>
  date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/** "8.50" -> "8.5". */
const marks = (value: Prisma.Decimal) => String(Number(value));

/**
 * In-app notifications for things that happen in the academy: new assignments and tests for a
 * batch, marked work, issued invoices, confirmed payments and assigned enquiries. Links point at
 * the student or faculty portal page for the item.
 *
 * Every method is best-effort: it is called after the action has been saved and never throws,
 * so a notification problem can't undo or fail the action that triggered it.
 */
@Injectable()
export class ActivityNotifier {
  private readonly logger = new Logger(ActivityNotifier.name);
  private lastReminderRun = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** A new or newly published assignment: its batch's current students. */
  assignmentPublished(assignmentId: bigint) {
    return this.safe('assignment', async () => {
      const a = await this.prisma.assignments.findUnique({
        where: { id: assignmentId },
        select: {
          id: true,
          title: true,
          batch_id: true,
          due_at: true,
          status: true,
        },
      });
      if (!a || a.status !== 'PUBLISHED') return;
      await this.once(await this.batchStudents([a.batch_id]), {
        title: `New assignment: ${a.title}`,
        message: a.due_at ? `Due ${shortDate(a.due_at)}.` : 'No due date.',
        linkUrl: `/student/assignments/${a.id}`,
        email: true,
      });
    });
  }

  /** A submission was marked or given feedback: the student who handed it in. */
  submissionReviewed(submissionId: bigint) {
    return this.safe('review', async () => {
      const s = await this.prisma.assignment_submissions.findUnique({
        where: { id: submissionId },
        select: {
          marks_awarded: true,
          feedback: true,
          assignments: { select: { id: true, title: true, max_marks: true } },
          enrollments: { select: { student_user_id: true } },
        },
      });
      if (!s) return;
      const score =
        s.marks_awarded !== null
          ? `You got ${marks(s.marks_awarded)}${s.assignments.max_marks ? ` out of ${marks(s.assignments.max_marks)}` : ''}.`
          : '';
      await this.notifications.notify([s.enrollments.student_user_id], {
        title: `Assignment marked: ${s.assignments.title}`,
        message:
          [score, s.feedback ? 'Your teacher left feedback.' : '']
            .filter(Boolean)
            .join(' ') || 'Your teacher has reviewed your work.',
        linkUrl: `/student/assignments/${s.assignments.id}`,
        email: true,
      });
    });
  }

  /**
   * A student handed in an assignment for the first time: the batch's teachers for its subject
   * (all of the batch's teachers when it has no subject) and whoever set it.
   */
  submissionReceived(submissionId: bigint) {
    return this.safe('submission', async () => {
      const s = await this.prisma.assignment_submissions.findUnique({
        where: { id: submissionId },
        select: {
          submitted_at: true,
          assignments: {
            select: {
              id: true,
              title: true,
              batch_id: true,
              subject_id: true,
              created_by: true,
              due_at: true,
            },
          },
          enrollments: {
            select: { student_profiles: { select: { users: { select: { full_name: true } } } } },
          },
        },
      });
      if (!s) return;
      const a = s.assignments;
      const teachers = await this.prisma.batch_faculty.findMany({
        where: {
          batch_id: a.batch_id,
          ...(a.subject_id ? { subject_id: a.subject_id } : {}),
          faculty_profiles: { users: { status: 'ACTIVE', deleted_at: null } },
        },
        select: { faculty_user_id: true },
      });
      const ids = new Set(teachers.map((t) => t.faculty_user_id));
      if (a.created_by) ids.add(a.created_by);
      const late = a.due_at && s.submitted_at > a.due_at ? ' (late)' : '';
      await this.notifications.notify([...ids], {
        title: `Work handed in: ${a.title}`,
        message: `${s.enrollments.student_profiles.users.full_name} handed in${late}. Ready to review.`,
        linkUrl: `/teach/assignments/${a.id}`,
      });
    });
  }

  /** A new enquiry from the website form: every active admin. */
  enquiryReceived(enquiryId: bigint) {
    return this.safe('new enquiry', async () => {
      const e = await this.prisma.admission_enquiries.findUnique({
        where: { id: enquiryId },
        select: {
          student_name: true,
          mobile: true,
          branch_id: true,
          courses: { select: { title: true } },
        },
      });
      if (!e) return;
      // Head office, and the admins of the enquiry's branch.
      const admins = await this.prisma.users.findMany({
        where: {
          status: 'ACTIVE',
          deleted_at: null,
          OR: [
            { user_roles: { some: { roles: { code: 'ADMIN' } } } },
            ...(e.branch_id === null
              ? []
              : [
                  {
                    branch_staff: {
                      some: {
                        branch_id: e.branch_id,
                        roles: { code: 'ADMIN' },
                      },
                    },
                  },
                ]),
          ],
        },
        select: { id: true },
      });
      await this.notifications.notify(
        admins.map((u) => u.id),
        {
          title: `New enquiry: ${e.student_name}`,
          message: `${e.mobile}${e.courses ? ` · interested in ${e.courses.title}` : ''}. Call them back.`,
          linkUrl: '/admin/enquiries',
        },
      );
    });
  }

  /** A published test, for all its batches or only the ones given (a batch attached later). */
  examPublished(examId: bigint, batchIds?: bigint[]) {
    return this.safe('exam', async () => {
      const exam = await this.prisma.exams.findUnique({
        where: { id: examId },
        select: {
          title: true,
          status: true,
          opens_at: true,
          closes_at: true,
          duration_minutes: true,
          exam_batches: { select: { batch_id: true } },
        },
      });
      if (!exam || exam.status !== 'PUBLISHED') return;
      const batches = batchIds ?? exam.exam_batches.map((b) => b.batch_id);
      const now = new Date();
      const when =
        exam.opens_at && exam.opens_at > now
          ? `Opens ${shortDate(exam.opens_at)}`
          : exam.closes_at
            ? `Open now, closes ${shortDate(exam.closes_at)}`
            : 'Open now';
      await this.once(await this.batchStudents(batches), {
        title: `New test: ${exam.title}`,
        message: `${when}. ${exam.duration_minutes} minutes.`,
        linkUrl: `/student/tests#exam-${examId}`,
        email: true,
      });
    });
  }

  /** An invoice was issued: the student it bills. */
  invoiceIssued(invoiceId: bigint) {
    return this.safe('invoice', async () => {
      const i = await this.prisma.fee_invoices.findUnique({
        where: { id: invoiceId },
        select: {
          status: true,
          invoice_number: true,
          amount_due: true,
          gross_amount: true,
          discount_amount: true,
          due_date: true,
          enrollments: { select: { student_user_id: true } },
        },
      });
      if (!i || i.status === 'DRAFT' || i.status === 'VOID') return;
      const amount = i.amount_due ?? i.gross_amount.minus(i.discount_amount);
      await this.once([i.enrollments.student_user_id], {
        title: `Fee invoice ${i.invoice_number}`,
        message: `${rupees(amount)}${i.due_date ? `, due ${i.due_date.toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.`,
        linkUrl: `/student/fees#invoice-${invoiceId}`,
        email: true,
      });
    });
  }

  /** A payment was confirmed (with its receipt number): the student who paid. */
  paymentConfirmed(paymentId: bigint) {
    return this.safe('payment', async () => {
      const p = await this.prisma.payments.findUnique({
        where: { id: paymentId },
        select: {
          status: true,
          amount: true,
          receipt_number: true,
          fee_invoices: {
            select: {
              id: true,
              invoice_number: true,
              enrollments: { select: { student_user_id: true } },
            },
          },
        },
      });
      if (!p || p.status !== 'CONFIRMED') return;
      await this.once([p.fee_invoices.enrollments.student_user_id], {
        title: `Payment received: ${rupees(p.amount)}`,
        message: `Against invoice ${p.fee_invoices.invoice_number}.${p.receipt_number ? ` Receipt ${p.receipt_number}.` : ''}`,
        linkUrl: `/student/fees#payment-${paymentId}`,
        email: true,
      });
    });
  }

  /** An enquiry was assigned to a staff member (not when they assign it to themselves). */
  enquiryAssigned(enquiryId: bigint, assigneeId: bigint, actorId: bigint) {
    if (assigneeId === actorId) return Promise.resolve();
    return this.safe('enquiry', async () => {
      const e = await this.prisma.admission_enquiries.findUnique({
        where: { id: enquiryId },
        select: {
          student_name: true,
          mobile: true,
          courses: { select: { title: true } },
        },
      });
      if (!e) return;
      // The faculty portal is for the Faculty role only, so admins who don't teach go to the admin portal.
      const faculty = await this.prisma.user_roles.findFirst({
        where: { user_id: assigneeId, roles: { code: 'FACULTY' } },
        select: { user_id: true },
      });
      await this.notifications.notify([assigneeId], {
        title: `Enquiry assigned: ${e.student_name}`,
        message: `${e.mobile}${e.courses ? ` · interested in ${e.courses.title}` : ''}. Please call them back.`,
        linkUrl: faculty ? '/teach/enquiries' : '/admin/enquiries',
      });
    });
  }

  /** A class scheduled in the future: its batch's current students. */
  classScheduled(sessionId: bigint) {
    return this.safe('class', async () => {
      const c = await this.session(sessionId);
      if (!c || c.status !== 'SCHEDULED' || c.starts_at <= new Date()) return;
      await this.once(await this.batchStudents([c.batch_id]), {
        title: `New class: ${c.title}`,
        message: `${shortDate(c.starts_at)}${c.subjects ? ` · ${c.subjects.name}` : ''}${c.meeting_url ? ' · online' : ''}.`,
        linkUrl: classLink(sessionId),
      });
    });
  }

  /**
   * After a class was edited: tells the batch when it was cancelled, moved to another time or got
   * its recording. `before` is the row as it was before the update.
   */
  classUpdated(
    sessionId: bigint,
    before: {
      status: string;
      starts_at: Date;
      ends_at: Date;
      recording_url: string | null;
    },
  ) {
    return this.safe('class change', async () => {
      const c = await this.session(sessionId);
      if (!c) return;
      const students = await this.batchStudents([c.batch_id]);
      const link = classLink(sessionId);
      if (c.status === 'CANCELLED' && before.status !== 'CANCELLED') {
        await this.once(students, {
          title: `Class cancelled: ${c.title}`,
          message: `The class on ${shortDate(before.starts_at)} will not take place.`,
          linkUrl: link,
        });
        return;
      }
      const moved =
        c.starts_at.getTime() !== before.starts_at.getTime() ||
        c.ends_at.getTime() !== before.ends_at.getTime();
      if (c.status === 'SCHEDULED' && moved && c.starts_at > new Date()) {
        // Not de-duplicated: a class can be moved more than once, and each move matters.
        await this.notifications.notify(students, {
          title: `Class moved: ${c.title}`,
          message: `Now ${shortDate(c.starts_at)} (was ${shortDate(before.starts_at)}).`,
          linkUrl: link,
        });
      }
      if (c.recording_url && !before.recording_url) {
        await this.once(students, {
          title: `Recording available: ${c.title}`,
          message: `The recording of the class on ${shortDate(c.starts_at)} is ready to watch.`,
          linkUrl: link,
        });
      }
    });
  }

  /**
   * Fallback when background jobs are off (JOBS_ENABLED=false): runs the class reminders when
   * notifications are read (the portal bell polls every minute), at most once a minute.
   */
  async remindUpcomingClassesLazily(): Promise<void> {
    if (jobsEnabled(this.config)) return;
    if (Date.now() - this.lastReminderRun < 60_000) return;
    this.lastReminderRun = Date.now();
    await this.remindUpcomingClasses();
  }

  /**
   * "Class at 5:30 pm" reminders for classes starting within the next hour, to the batch's students
   * and the class teacher, once each. Run every minute by the scheduled jobs.
   */
  async remindUpcomingClasses(): Promise<void> {
    await this.safe('class reminders', async () => {
      const now = new Date();
      const soon = await this.prisma.class_sessions.findMany({
        where: {
          status: 'SCHEDULED',
          starts_at: { gt: now, lte: new Date(now.getTime() + 60 * 60 * 1000) },
        },
        select: {
          id: true,
          batch_id: true,
          title: true,
          starts_at: true,
          meeting_url: true,
          faculty_user_id: true,
        },
      });
      for (const c of soon) {
        const at = shortTime(c.starts_at);
        const message = c.meeting_url
          ? 'Online class: the join link opens 15 minutes before the start.'
          : 'Please be on time.';
        await this.once(await this.batchStudents([c.batch_id]), {
          title: `Class at ${at}: ${c.title}`,
          message,
          linkUrl: classLink(c.id),
        });
        if (c.faculty_user_id)
          await this.once([c.faculty_user_id], {
            title: `Class at ${at}: ${c.title}`,
            message: 'Your class starts within the hour.',
            linkUrl: `/teach/classes/${c.id}`,
          });
      }
    });
  }

  private session(id: bigint) {
    return this.prisma.class_sessions.findUnique({
      where: { id },
      select: {
        id: true,
        batch_id: true,
        title: true,
        status: true,
        starts_at: true,
        ends_at: true,
        meeting_url: true,
        recording_url: true,
        subjects: { select: { name: true } },
      },
    });
  }

  /** Students actively enrolled (ACTIVE, inside the access window) in any of the batches. */
  private async batchStudents(batchIds: bigint[]): Promise<bigint[]> {
    if (!batchIds.length) return [];
    const rows = await this.prisma.enrollments.findMany({
      where: {
        batch_id: { in: batchIds },
        ...currentEnrollmentWhere(),
        student_profiles: { users: { status: 'ACTIVE', deleted_at: null } },
      },
      select: { student_user_id: true },
    });
    return rows.map((r) => r.student_user_id);
  }

  /**
   * Notifies each user at most once per item: someone already sent this title and link (e.g. an
   * assignment closed and re-published, or a payment status set to CONFIRMED twice) is skipped.
   */
  private async once(
    userIds: bigint[],
    input: NotificationInput & { linkUrl: string },
  ) {
    if (!userIds.length) return;
    const already = await this.prisma.notifications.findMany({
      where: {
        user_id: { in: userIds },
        link_url: input.linkUrl,
        title: input.title.slice(0, 200),
      },
      select: { user_id: true },
    });
    const skip = new Set(already.map((n) => n.user_id));
    await this.notifications.notify(
      userIds.filter((id) => !skip.has(id)),
      input,
    );
  }

  private async safe(what: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.error(
        `Could not send the ${what} notification: ${String(error)}`,
      );
    }
  }
}
