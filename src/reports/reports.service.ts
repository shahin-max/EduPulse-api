import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, isAdmin } from '../common/auth.js';

/** Enrollments that count as the batch's students in reports (not pending or cancelled). */
const REPORT_ENROLLMENT_STATUSES = ['ACTIVE', 'PAUSED', 'COMPLETED'] as const;
const GRADED_ATTEMPT_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AttendanceSummary = {
  present: number;
  late: number;
  absent: number;
  excused: number;
  /** Present or late, as a share of present + late + absent (excused classes do not count). Null before any marking. */
  percentage: number | null;
};

export type SubmissionState = 'MISSING' | 'NOT_DUE' | 'SUBMITTED' | 'LATE' | 'REVIEWED';

export function attendanceSummary(counts: Partial<Record<string, number>>): AttendanceSummary {
  const present = counts.PRESENT ?? 0;
  const late = counts.LATE ?? 0;
  const absent = counts.ABSENT ?? 0;
  const excused = counts.EXCUSED ?? 0;
  const counted = present + late + absent;
  return {
    present,
    late,
    absent,
    excused,
    percentage: counted ? round1(((present + late) / counted) * 100) : null,
  };
}

/** Where a student stands on one assignment. */
export function submissionState(
  submission: { submitted_at: Date; reviewed_at: Date | null } | undefined,
  dueAt: Date | null,
  now = new Date(),
): SubmissionState {
  if (!submission) return dueAt && dueAt > now ? 'NOT_DUE' : 'MISSING';
  if (submission.reviewed_at) return 'REVIEWED';
  return dueAt && submission.submitted_at > dueAt ? 'LATE' : 'SUBMITTED';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Teaching reports for admins and the faculty assigned to a batch: the batch gradebook, one
 * student's progress, and the faculty dashboard. Read-only; access follows AccessService.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Every student of the batch against attendance, assignments, exams and study materials. */
  async gradebook(batchId: bigint, user: AuthUser) {
    await this.access.assertCanManageBatch(user, batchId);
    const batch = await this.prisma.batches.findUniqueOrThrow({
      where: { id: batchId },
      select: {
        id: true,
        code: true,
        name: true,
        status: true,
        course_id: true,
        courses: { select: { id: true, code: true, title: true } },
      },
    });

    const [enrollments, assignments, exams, sessionsHeld, materialsTotal] =
      await Promise.all([
        this.prisma.enrollments.findMany({
          where: { batch_id: batchId, status: { in: [...REPORT_ENROLLMENT_STATUSES] } },
          select: {
            id: true,
            status: true,
            student_user_id: true,
            student_profiles: {
              select: {
                admission_number: true,
                users: { select: { full_name: true, photo_url: true } },
              },
            },
          },
        }),
        this.batchAssignments(batchId),
        this.batchExams(batchId),
        this.heldSessionsCount(batchId),
        this.publishedMaterialsCount(batch.course_id),
      ]);

    const enrollmentIds = enrollments.map((e) => e.id);
    const [attendance, submissions, attempts, completed] = await Promise.all([
      this.prisma.class_attendance.groupBy({
        by: ['enrollment_id', 'status'],
        where: { batch_id: batchId, enrollment_id: { in: enrollmentIds } },
        _count: { _all: true },
      }),
      this.prisma.assignment_submissions.findMany({
        where: {
          batch_id: batchId,
          enrollment_id: { in: enrollmentIds },
          assignment_id: { in: assignments.map((a) => a.id) },
        },
        select: {
          assignment_id: true,
          enrollment_id: true,
          submitted_at: true,
          reviewed_at: true,
          marks_awarded: true,
        },
      }),
      this.prisma.exam_attempts.findMany({
        where: {
          batch_id: batchId,
          enrollment_id: { in: enrollmentIds },
          exam_id: { in: exams.map((e) => e.id) },
          status: { in: [...GRADED_ATTEMPT_STATUSES] },
        },
        select: {
          exam_id: true,
          enrollment_id: true,
          score: true,
          max_score: true,
          percentage: true,
        },
      }),
      this.completedMaterials(enrollmentIds, batch.course_id),
    ]);

    const now = new Date();
    const students = enrollments
      .map((enrollment) => {
        const counts: Record<string, number> = {};
        for (const row of attendance)
          if (row.enrollment_id === enrollment.id)
            counts[row.status] = row._count._all;
        const assignmentCells: Record<string, unknown> = {};
        for (const a of assignments) {
          const sub = submissions.find(
            (s) => s.assignment_id === a.id && s.enrollment_id === enrollment.id,
          );
          assignmentCells[String(a.id)] = {
            state: submissionState(sub, a.due_at, now),
            marks: sub?.marks_awarded ?? null,
          };
        }
        const examCells: Record<string, unknown> = {};
        for (const exam of exams) {
          const mine = attempts.filter(
            (t) => t.exam_id === exam.id && t.enrollment_id === enrollment.id,
          );
          const best = bestAttempt(mine);
          examCells[String(exam.id)] = {
            attempts: mine.length,
            score: best?.score ?? null,
            max_score: best?.max_score ?? null,
            percentage: best?.percentage ?? null,
          };
        }
        return {
          enrollment_id: enrollment.id,
          enrollment_status: enrollment.status,
          user_id: enrollment.student_user_id,
          full_name: enrollment.student_profiles.users.full_name,
          photo_url: enrollment.student_profiles.users.photo_url,
          admission_number: enrollment.student_profiles.admission_number,
          attendance: attendanceSummary(counts),
          assignments: assignmentCells,
          exams: examCells,
          materials_completed: completed.get(enrollment.id) ?? 0,
        };
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name));

    return {
      batch,
      sessions_held: sessionsHeld,
      materials_total: materialsTotal,
      assignments,
      exams,
      students,
    };
  }

  /** One student of the batch: profile, attendance by class, assignments, exam attempts, materials. */
  async studentReport(batchId: bigint, studentUserId: bigint, user: AuthUser) {
    await this.access.assertCanManageBatch(user, batchId);
    const enrollment = await this.prisma.enrollments.findFirst({
      where: { batch_id: batchId, student_user_id: studentUserId },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        status: true,
        enrolled_at: true,
        completed_at: true,
        batches: {
          select: {
            id: true,
            code: true,
            name: true,
            course_id: true,
            courses: { select: { id: true, code: true, title: true } },
          },
        },
        student_profiles: {
          select: {
            admission_number: true,
            grade: true,
            school_name: true,
            guardian_name: true,
            guardian_mobile: true,
            users: {
              select: {
                id: true,
                full_name: true,
                email: true,
                mobile: true,
                photo_url: true,
              },
            },
          },
        },
      },
    });
    if (!enrollment)
      throw new NotFoundException('This student is not enrolled in the batch');
    const courseId = enrollment.batches.course_id;

    const [sessions, assignments, exams, materialsTotal, progress] =
      await Promise.all([
        this.prisma.class_sessions.findMany({
          where: {
            batch_id: batchId,
            status: { not: 'CANCELLED' },
            starts_at: { lte: new Date() },
          },
          orderBy: { starts_at: 'desc' },
          take: 200,
          select: {
            id: true,
            title: true,
            starts_at: true,
            ends_at: true,
            status: true,
            subjects: { select: { id: true, name: true } },
            class_attendance: {
              where: { enrollment_id: enrollment.id },
              select: { status: true },
            },
          },
        }),
        this.prisma.assignments.findMany({
          where: { batch_id: batchId, status: { in: ['PUBLISHED', 'CLOSED'] } },
          orderBy: [{ due_at: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            title: true,
            due_at: true,
            max_marks: true,
            status: true,
            subjects: { select: { id: true, name: true } },
            assignment_submissions: {
              where: { enrollment_id: enrollment.id },
              select: {
                id: true,
                submitted_at: true,
                marks_awarded: true,
                feedback: true,
                reviewed_at: true,
              },
            },
          },
        }),
        this.prisma.exams.findMany({
          where: {
            status: { in: ['PUBLISHED', 'CLOSED'] },
            exam_batches: { some: { batch_id: batchId } },
          },
          orderBy: [{ opens_at: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            title: true,
            kind: true,
            total_marks: true,
            opens_at: true,
            closes_at: true,
            exam_attempts: {
              where: { batch_id: batchId, enrollment_id: enrollment.id },
              orderBy: { attempt_number: 'asc' },
              select: {
                id: true,
                attempt_number: true,
                status: true,
                started_at: true,
                submitted_at: true,
                score: true,
                max_score: true,
                percentage: true,
                correct_count: true,
                wrong_count: true,
                unanswered_count: true,
              },
            },
          },
        }),
        this.publishedMaterialsCount(courseId),
        this.prisma.material_progress.groupBy({
          by: ['status'],
          where: {
            enrollment_id: enrollment.id,
            study_materials: publishedMaterialWhere(courseId),
          },
          _count: { _all: true },
        }),
      ]);

    const counts: Record<string, number> = {};
    for (const s of sessions) {
      const status = s.class_attendance[0]?.status;
      if (status) counts[status] = (counts[status] ?? 0) + 1;
    }
    const now = new Date();
    const progressCount = (status: string) =>
      progress.find((p) => p.status === status)?._count._all ?? 0;

    return {
      enrollment: {
        id: enrollment.id,
        status: enrollment.status,
        enrolled_at: enrollment.enrolled_at,
        completed_at: enrollment.completed_at,
      },
      batch: enrollment.batches,
      student: enrollment.student_profiles,
      attendance: {
        ...attendanceSummary(counts),
        sessions: sessions.map(({ class_attendance, ...s }) => ({
          ...s,
          attendance: class_attendance[0]?.status ?? null,
        })),
      },
      assignments: assignments.map(({ assignment_submissions, ...a }) => ({
        ...a,
        submission: assignment_submissions[0] ?? null,
        state: submissionState(assignment_submissions[0], a.due_at, now),
      })),
      exams: exams.map(({ exam_attempts, ...e }) => {
        const graded = exam_attempts.filter((t) =>
          (GRADED_ATTEMPT_STATUSES as readonly string[]).includes(t.status),
        );
        return { ...e, attempts: exam_attempts, best: bestAttempt(graded) ?? null };
      }),
      materials: {
        total: materialsTotal,
        completed: progressCount('COMPLETED'),
        in_progress: progressCount('IN_PROGRESS'),
      },
    };
  }

  /**
   * The faculty home page: work waiting for the signed-in person in the batches they teach
   * (admins: every batch).
   */
  async dashboard(user: AuthUser) {
    // Only batches the person teaches count (admins: all of them).
    const batchIds: bigint[] | 'all' =
      isAdmin(user)
        ? 'all'
        : (
            await this.prisma.batch_faculty.findMany({
              where: { faculty_user_id: user.id },
              select: { batch_id: true },
              distinct: ['batch_id'],
            })
          ).map((r) => r.batch_id);
    const inBatches = batchIds === 'all' ? {} : { batch_id: { in: batchIds } };
    const now = new Date();

    // Classes that ended in the last two weeks without any attendance. Faculty see the ones they
    // teach, or unassigned ones in their batches; admins see all.
    const attendanceWhere: Prisma.class_sessionsWhereInput = {
      ...inBatches,
      status: { not: 'CANCELLED' },
      ends_at: { lt: now, gte: new Date(now.getTime() - 14 * DAY_MS) },
      class_attendance: { none: {} },
      ...(isAdmin(user)
        ? {}
        : { OR: [{ faculty_user_id: user.id }, { faculty_user_id: null }] }),
    };
    const toReviewWhere: Prisma.assignment_submissionsWhereInput = {
      ...inBatches,
      reviewed_at: null,
      assignments: { status: { not: 'DRAFT' } },
    };
    const dueSoonWhere: Prisma.assignmentsWhereInput = {
      ...inBatches,
      status: 'PUBLISHED',
      due_at: { gte: now, lte: new Date(now.getTime() + 7 * DAY_MS) },
    };
    const examsWhere: Prisma.examsWhereInput = {
      status: 'PUBLISHED',
      OR: [{ closes_at: null }, { closes_at: { gte: now } }],
      AND: [{ OR: [{ opens_at: null }, { opens_at: { lte: new Date(now.getTime() + 14 * DAY_MS) } }] }],
      ...(batchIds === 'all' ? {} : { exam_batches: { some: { batch_id: { in: batchIds } } } }),
    };

    const [
      toReviewCount,
      toReview,
      attendancePendingCount,
      attendancePending,
      dueSoon,
      upcomingExams,
      newEnquiries,
      followUps,
    ] = await Promise.all([
      this.prisma.assignment_submissions.count({ where: toReviewWhere }),
      this.prisma.assignment_submissions.findMany({
        where: toReviewWhere,
        orderBy: { submitted_at: 'asc' },
        take: 8,
        select: {
          id: true,
          submitted_at: true,
          assignments: {
            select: { id: true, title: true, due_at: true, batches: { select: { id: true, code: true, name: true } } },
          },
          enrollments: {
            select: { student_profiles: { select: { users: { select: { id: true, full_name: true, photo_url: true } } } } },
          },
        },
      }),
      this.prisma.class_sessions.count({ where: attendanceWhere }),
      this.prisma.class_sessions.findMany({
        where: attendanceWhere,
        orderBy: { starts_at: 'desc' },
        take: 6,
        select: {
          id: true,
          title: true,
          starts_at: true,
          ends_at: true,
          batches: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.assignments.findMany({
        where: dueSoonWhere,
        orderBy: { due_at: 'asc' },
        take: 6,
        select: {
          id: true,
          title: true,
          due_at: true,
          batches: { select: { id: true, code: true, name: true } },
          _count: { select: { assignment_submissions: true } },
        },
      }),
      this.prisma.exams.findMany({
        where: examsWhere,
        orderBy: [{ opens_at: 'asc' }, { id: 'asc' }],
        take: 6,
        select: {
          id: true,
          title: true,
          kind: true,
          opens_at: true,
          closes_at: true,
          duration_minutes: true,
          exam_batches: {
            where: batchIds === 'all' ? {} : { batch_id: { in: batchIds } },
            select: { batches: { select: { id: true, code: true, name: true } } },
          },
        },
      }),
      this.prisma.admission_enquiries.count({
        where: { assigned_to: user.id, status: 'NEW' },
      }),
      this.prisma.admission_enquiries.count({
        where: { assigned_to: user.id, status: 'FOLLOW_UP' },
      }),
    ]);

    // Students enrolled per due-soon assignment's batch, to show "12 / 30 submitted".
    const dueBatchIds = [...new Set(dueSoon.map((a) => a.batches.id))];
    const enrolled = dueBatchIds.length
      ? await this.prisma.enrollments.groupBy({
          by: ['batch_id'],
          where: { batch_id: { in: dueBatchIds }, status: 'ACTIVE' },
          _count: { _all: true },
        })
      : [];

    return {
      to_review: {
        total: toReviewCount,
        items: toReview.map((s) => ({
          submission_id: s.id,
          submitted_at: s.submitted_at,
          assignment: { id: s.assignments.id, title: s.assignments.title, due_at: s.assignments.due_at },
          batch: s.assignments.batches,
          student: s.enrollments.student_profiles.users,
        })),
      },
      attendance_pending: { total: attendancePendingCount, items: attendancePending },
      due_soon: dueSoon.map(({ _count, ...a }) => ({
        ...a,
        submitted: _count.assignment_submissions,
        enrolled: enrolled.find((e) => e.batch_id === a.batches.id)?._count._all ?? 0,
      })),
      upcoming_exams: upcomingExams.map(({ exam_batches, ...e }) => ({
        ...e,
        batches: exam_batches.map((b) => b.batches),
      })),
      enquiries: { new: newEnquiries, follow_up: followUps },
    };
  }

  private batchAssignments(batchId: bigint) {
    return this.prisma.assignments.findMany({
      where: { batch_id: batchId, status: { in: ['PUBLISHED', 'CLOSED'] } },
      orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, due_at: true, max_marks: true },
    });
  }

  private batchExams(batchId: bigint) {
    return this.prisma.exams.findMany({
      where: {
        status: { in: ['PUBLISHED', 'CLOSED'] },
        exam_batches: { some: { batch_id: batchId } },
      },
      orderBy: [{ opens_at: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, kind: true, total_marks: true, opens_at: true },
    });
  }

  /** Classes that have started and were not cancelled. */
  private heldSessionsCount(batchId: bigint) {
    return this.prisma.class_sessions.count({
      where: { batch_id: batchId, status: { not: 'CANCELLED' }, starts_at: { lte: new Date() } },
    });
  }

  private publishedMaterialsCount(courseId: bigint) {
    return this.prisma.study_materials.count({
      where: publishedMaterialWhere(courseId),
    });
  }

  private async completedMaterials(
    enrollmentIds: bigint[],
    courseId: bigint,
  ): Promise<Map<bigint, number>> {
    if (!enrollmentIds.length) return new Map();
    const rows = await this.prisma.material_progress.groupBy({
      by: ['enrollment_id'],
      where: {
        enrollment_id: { in: enrollmentIds },
        status: 'COMPLETED',
        study_materials: publishedMaterialWhere(courseId),
      },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.enrollment_id, r._count._all]));
  }
}

/** Published materials in published chapters of the course (what students can see). */
function publishedMaterialWhere(courseId: bigint): Prisma.study_materialsWhereInput {
  return {
    is_published: true,
    chapters: { is_published: true, course_subjects: { course_id: courseId } },
  };
}

/** The attempt with the highest percentage (then score). */
function bestAttempt<T extends { percentage: Prisma.Decimal | null; score: Prisma.Decimal | null }>(
  attempts: T[],
): T | undefined {
  let best: T | undefined;
  for (const a of attempts) {
    if (!best) best = a;
    else {
      const pa = a.percentage?.toNumber() ?? -1;
      const pb = best.percentage?.toNumber() ?? -1;
      if (pa > pb || (pa === pb && (a.score?.toNumber() ?? -1) > (best.score?.toNumber() ?? -1)))
        best = a;
    }
  }
  return best;
}
