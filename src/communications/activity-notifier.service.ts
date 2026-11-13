import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
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
      });
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
      await this.notifications.notify([assigneeId], {
        title: `Enquiry assigned: ${e.student_name}`,
        message: `${e.mobile}${e.courses ? ` · interested in ${e.courses.title}` : ''}. Please call them back.`,
        // Faculty follow up in their portal; admins also open it there or in the admin portal.
        linkUrl: '/teach/enquiries',
      });
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
