import { ActivityNotifier } from '../communications/activity-notifier.service.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { exams } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentEnrollmentWhere } from '../common/access.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, hasRole, isAdmin, RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import {
  examWindowState,
  FINISHED_STATUSES,
  rankAttempts,
  resultsVisible,
  selectRankedAttempts,
  toDecimal,
} from './exam-rules.js';
import {
  AddExamQuestionDto,
  CreateExamDto,
  LeaderboardQueryDto,
  ListAttemptsQueryDto,
  ListExamsQueryDto,
  UpdateExamDto,
  UpdateExamQuestionDto,
} from './dto/exams.dto.js';

const examSummaryInclude = {
  courses: { select: { id: true, code: true, title: true } },
  subjects: { select: { id: true, code: true, name: true } },
  exam_batches: {
    select: { batches: { select: { id: true, code: true, name: true } } },
  },
  _count: { select: { exam_questions: true, exam_attempts: true } },
} satisfies Prisma.examsInclude;

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly notifier: ActivityNotifier,
  ) {}

  // ---- Permissions ----

  async getExam(id: bigint) {
    const exam = await this.prisma.exams.findUnique({ where: { id } });
    if (!exam) throw new NotFoundException('Exam not found');
    return exam;
  }

  /**
   * Admins manage every exam. Faculty manage an exam when they teach every batch it is
   * attached to (or, before any batch is attached, when they created it).
   */
  async canManage(user: AuthUser, exam: exams): Promise<boolean> {
    if (isAdmin(user)) return true;
    if (!hasRole(user, RoleCode.FACULTY)) return false;
    const batches = await this.prisma.exam_batches.findMany({
      where: { exam_id: exam.id },
      select: { batch_id: true },
    });
    if (batches.length === 0) return exam.created_by === user.id;
    for (const { batch_id } of batches) {
      if (!(await this.access.isBatchFaculty(user.id, batch_id))) return false;
    }
    return true;
  }

  async assertCanManage(user: AuthUser, examId: bigint): Promise<exams> {
    const exam = await this.getExam(examId);
    if (!(await this.canManage(user, exam))) {
      throw new ForbiddenException(
        'Only admins and faculty teaching all of this exam’s batches can manage it',
      );
    }
    return exam;
  }

  // ---- Exams ----

  async findAll(query: ListExamsQueryDto, user: AuthUser) {
    let scope: Prisma.examsWhereInput = {};
    if (!isAdmin(user)) {
      const mine = await this.prisma.batch_faculty.findMany({
        where: { faculty_user_id: user.id },
        select: { batch_id: true },
      });
      scope = {
        OR: [
          { created_by: user.id },
          {
            exam_batches: {
              some: { batch_id: { in: mine.map((b) => b.batch_id) } },
            },
          },
        ],
      };
    }
    const where: Prisma.examsWhereInput = {
      ...scope,
      course_id:
        query.courseId === undefined ? undefined : BigInt(query.courseId),
      status: query.status,
      ...(query.batchId !== undefined
        ? { exam_batches: { some: { batch_id: BigInt(query.batchId) } } }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.exams.findMany({
        where,
        include: examSummaryInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.exams.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** Staff: full exam with questions and correct answers. */
  async detail(id: bigint) {
    return this.prisma.exams.findUniqueOrThrow({
      where: { id },
      include: {
        ...examSummaryInclude,
        exam_questions: {
          orderBy: { sort_order: 'asc' },
          include: {
            questions: {
              include: {
                question_options: {
                  orderBy: [{ sort_order: 'asc' }, { option_label: 'asc' }],
                },
              },
            },
          },
        },
      },
    });
  }

  /** Staff get the full exam; students get the exam info (no questions) if it is for one of their batches. */
  async findOne(id: bigint, user: AuthUser) {
    const exam = await this.getExam(id);
    if (await this.canManage(user, exam)) return this.detail(id);
    const enrollments = await this.studentEnrollments(user, exam.id);
    if (!enrollments.length || exam.status === 'DRAFT')
      throw new NotFoundException('Exam not found');
    const attempts = await this.prisma.exam_attempts.findMany({
      where: {
        exam_id: id,
        enrollment_id: { in: enrollments.map((e) => e.id) },
      },
      select: { id: true, attempt_number: true, status: true },
      orderBy: { attempt_number: 'asc' },
    });
    const used = attempts.filter((a) => a.status !== 'INVALIDATED').length;
    const { created_by: _createdBy, ...info } = exam;
    return {
      ...info,
      window: examWindowState(exam),
      results_visible: resultsVisible(exam),
      attempts,
      attempts_remaining: Math.max(exam.max_attempts - used, 0),
    };
  }

  async create(dto: CreateExamDto, user: AuthUser) {
    await this.assertCourseSubject(dto.courseId, dto.subjectId);
    assertWindow(dto.opensAt, dto.closesAt);
    return this.prisma.exams.create({
      data: {
        course_id: BigInt(dto.courseId),
        subject_id:
          dto.subjectId === undefined || dto.subjectId === null
            ? null
            : BigInt(dto.subjectId),
        title: dto.title,
        kind: dto.kind,
        duration_minutes: dto.durationMinutes,
        negative_marks_per_wrong:
          dto.negativeMarksPerWrong === undefined
            ? undefined
            : toDecimal(dto.negativeMarksPerWrong),
        max_attempts: dto.maxAttempts,
        opens_at: dto.opensAt,
        closes_at: dto.closesAt,
        results_release_at: dto.resultsReleaseAt,
        answer_review_release_at: dto.answerReviewReleaseAt,
        ranking_attempt_policy: dto.rankingAttemptPolicy,
        show_result_immediately: dto.showResultImmediately,
        created_by: user.id,
      },
      include: examSummaryInclude,
    });
  }

  async update(id: bigint, dto: UpdateExamDto, user: AuthUser) {
    const exam = await this.assertCanManage(user, id);
    if (dto.subjectId !== undefined)
      await this.assertCourseSubject(Number(exam.course_id), dto.subjectId);
    assertWindow(
      dto.opensAt === undefined ? exam.opens_at : dto.opensAt,
      dto.closesAt === undefined ? exam.closes_at : dto.closesAt,
    );
    if (dto.status && dto.status !== exam.status)
      await this.assertStatusChange(exam, dto.status);
    // Each exam question copies the exam's penalty when it is added. Changing the exam's penalty
    // afterwards must reach the questions still on the old default, or the exam would say
    // "-1 per wrong" while scoring 0. Questions given their own penalty keep it.
    const newPenalty =
      dto.negativeMarksPerWrong === undefined
        ? undefined
        : toDecimal(dto.negativeMarksPerWrong);
    const penaltyChanged =
      newPenalty !== undefined &&
      !new Prisma.Decimal(exam.negative_marks_per_wrong).equals(newPenalty);
    if (penaltyChanged)
      await this.assertNoAttempts(
        id,
        'Students have already attempted this exam, so its negative marking can no longer change',
      );
    const [updated] = await this.prisma.$transaction([
      this.updateExamRow(id, dto, newPenalty),
      ...(penaltyChanged
        ? [
            this.prisma.exam_questions.updateMany({
              where: {
                exam_id: id,
                negative_marks: exam.negative_marks_per_wrong,
              },
              data: { negative_marks: newPenalty },
            }),
          ]
        : []),
    ]);
    if (updated.status === 'PUBLISHED' && exam.status !== 'PUBLISHED')
      await this.notifier.examPublished(id);
    return updated;
  }

  private updateExamRow(
    id: bigint,
    dto: UpdateExamDto,
    newPenalty: Prisma.Decimal | undefined,
  ) {
    return this.prisma.exams.update({
      where: { id },
      data: {
        subject_id:
          dto.subjectId === undefined
            ? undefined
            : dto.subjectId === null
              ? null
              : BigInt(dto.subjectId),
        title: dto.title,
        kind: dto.kind,
        duration_minutes: dto.durationMinutes,
        negative_marks_per_wrong: newPenalty,
        max_attempts: dto.maxAttempts,
        opens_at: dto.opensAt,
        closes_at: dto.closesAt,
        results_release_at: dto.resultsReleaseAt,
        answer_review_release_at: dto.answerReviewReleaseAt,
        ranking_attempt_policy: dto.rankingAttemptPolicy,
        show_result_immediately: dto.showResultImmediately,
        status: dto.status,
      },
      include: examSummaryInclude,
    });
  }

  /** Exams with attempts cannot be deleted; close them instead. */
  async remove(id: bigint, user: AuthUser): Promise<void> {
    await this.assertCanManage(user, id);
    await this.assertNoAttempts(
      id,
      'This exam has attempts and cannot be deleted; set its status to CLOSED instead',
    );
    await this.prisma.$transaction([
      this.prisma.exam_questions.deleteMany({ where: { exam_id: id } }),
      this.prisma.exam_batches.deleteMany({ where: { exam_id: id } }),
      this.prisma.exams.delete({ where: { id } }),
    ]);
  }

  // ---- Batches ----

  async attachBatch(examId: bigint, batchId: bigint, user: AuthUser) {
    const exam = await this.assertCanManage(user, examId);
    const batch = await this.access.assertBatchExists(batchId);
    if (batch.course_id !== exam.course_id)
      throw new BadRequestException('The batch belongs to a different course');
    if (
      !isAdmin(user) &&
      !(await this.access.isBatchFaculty(user.id, batchId))
    ) {
      throw new ForbiddenException('You can only attach batches you teach');
    }
    const existing = await this.prisma.exam_batches.findUnique({
      where: { exam_id_batch_id: { exam_id: examId, batch_id: batchId } },
    });
    if (existing)
      throw new ConflictException('The batch is already attached to this exam');
    await this.prisma.exam_batches.create({
      data: { exam_id: examId, batch_id: batchId },
    });
    // A batch added to a test that is already live hears about it now.
    if (exam.status === 'PUBLISHED')
      await this.notifier.examPublished(examId, [batchId]);
    return this.detail(examId);
  }

  async detachBatch(
    examId: bigint,
    batchId: bigint,
    user: AuthUser,
  ): Promise<void> {
    await this.assertCanManage(user, examId);
    const link = await this.prisma.exam_batches.findUnique({
      where: { exam_id_batch_id: { exam_id: examId, batch_id: batchId } },
    });
    if (!link)
      throw new NotFoundException('The batch is not attached to this exam');
    const attempts = await this.prisma.exam_attempts.count({
      where: { exam_id: examId, batch_id: batchId },
    });
    if (attempts)
      throw new ConflictException(
        'Students of this batch have already attempted the exam',
      );
    await this.prisma.exam_batches.delete({
      where: { exam_id_batch_id: { exam_id: examId, batch_id: batchId } },
    });
  }

  // ---- Questions ----

  async addQuestion(examId: bigint, dto: AddExamQuestionDto, user: AuthUser) {
    const exam = await this.assertCanManage(user, examId);
    await this.assertQuestionsEditable(examId);
    const questionId = BigInt(dto.questionId);
    const question = await this.prisma.questions.findUnique({
      where: { id: questionId },
      include: {
        course_subjects: { select: { course_id: true, subject_id: true } },
      },
    });
    if (!question)
      throw new BadRequestException('questionId does not match any question');
    if (!question.is_active)
      throw new BadRequestException('This question is inactive');
    if (question.course_subjects.course_id !== exam.course_id)
      throw new BadRequestException(
        'The question belongs to a different course',
      );
    if (
      exam.subject_id &&
      question.course_subjects.subject_id !== exam.subject_id
    ) {
      throw new BadRequestException(
        'The question belongs to a different subject than this exam',
      );
    }
    const existing = await this.prisma.exam_questions.findUnique({
      where: {
        exam_id_question_id: { exam_id: examId, question_id: questionId },
      },
    });
    if (existing)
      throw new ConflictException('The question is already in this exam');

    await this.prisma.$transaction(async (tx) => {
      const last = await tx.exam_questions.aggregate({
        where: { exam_id: examId },
        _max: { sort_order: true },
      });
      await tx.exam_questions.create({
        data: {
          exam_id: examId,
          question_id: questionId,
          sort_order: (last._max.sort_order ?? 0) + 1,
          marks:
            dto.marks === undefined
              ? question.marks_default
              : toDecimal(dto.marks),
          negative_marks:
            dto.negativeMarks === undefined
              ? exam.negative_marks_per_wrong
              : toDecimal(dto.negativeMarks),
        },
      });
      await recomputeTotal(tx, examId);
    });
    return this.detail(examId);
  }

  async updateQuestion(
    examId: bigint,
    questionId: bigint,
    dto: UpdateExamQuestionDto,
    user: AuthUser,
  ) {
    await this.assertCanManage(user, examId);
    await this.assertQuestionsEditable(examId);
    await this.prisma.$transaction(async (tx) => {
      await tx.exam_questions.update({
        where: {
          exam_id_question_id: { exam_id: examId, question_id: questionId },
        },
        data: {
          marks: dto.marks === undefined ? undefined : toDecimal(dto.marks),
          negative_marks:
            dto.negativeMarks === undefined
              ? undefined
              : toDecimal(dto.negativeMarks),
        },
      });
      await recomputeTotal(tx, examId);
    });
    return this.detail(examId);
  }

  async removeQuestion(
    examId: bigint,
    questionId: bigint,
    user: AuthUser,
  ): Promise<void> {
    await this.assertCanManage(user, examId);
    await this.assertQuestionsEditable(examId);
    await this.prisma.$transaction(async (tx) => {
      await tx.exam_questions.delete({
        where: {
          exam_id_question_id: { exam_id: examId, question_id: questionId },
        },
      });
      await recomputeTotal(tx, examId);
    });
  }

  /** Sets the order of all questions. sort_order is unique per exam, so shift everything first. */
  async reorderQuestions(
    examId: bigint,
    questionIds: number[],
    user: AuthUser,
  ) {
    await this.assertCanManage(user, examId);
    await this.assertQuestionsEditable(examId);
    const current = await this.prisma.exam_questions.findMany({
      where: { exam_id: examId },
      select: { question_id: true },
    });
    const have = new Set(current.map((q) => String(q.question_id)));
    if (
      current.length !== questionIds.length ||
      !questionIds.every((id) => have.has(String(id)))
    ) {
      throw new BadRequestException(
        'questionIds must list every question of the exam exactly once',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.exam_questions.updateMany({
        where: { exam_id: examId },
        data: { sort_order: { increment: 1_000_000 } },
      });
      for (const [index, id] of questionIds.entries()) {
        await tx.exam_questions.update({
          where: {
            exam_id_question_id: { exam_id: examId, question_id: BigInt(id) },
          },
          data: { sort_order: index + 1 },
        });
      }
    });
    return this.detail(examId);
  }

  // ---- Attempts (staff) and leaderboard ----

  async listAttempts(
    examId: bigint,
    query: ListAttemptsQueryDto,
    user: AuthUser,
  ) {
    await this.assertCanManage(user, examId);
    const where: Prisma.exam_attemptsWhereInput = {
      exam_id: examId,
      batch_id: query.batchId === undefined ? undefined : BigInt(query.batchId),
      status: query.status,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.exam_attempts.findMany({
        where,
        include: {
          enrollments: {
            select: {
              student_profiles: {
                select: {
                  user_id: true,
                  admission_number: true,
                  users: { select: { full_name: true } },
                },
              },
            },
          },
          exam_batches: {
            select: { batches: { select: { id: true, code: true } } },
          },
        },
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.exam_attempts.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /**
   * One entry per student, chosen by the exam's ranking_attempt_policy, among SUBMITTED and
   * AUTO_SUBMITTED attempts. Staff can always see it; students only once results are released
   * and only if they are in one of the exam's batches.
   */
  async leaderboard(
    examId: bigint,
    query: LeaderboardQueryDto,
    user: AuthUser,
  ) {
    const exam = await this.getExam(examId);
    const staff = await this.canManage(user, exam);
    if (!staff) {
      const enrollments = await this.studentEnrollments(user, examId);
      if (!enrollments.length)
        throw new ForbiddenException('You are not part of this exam');
      if (!resultsVisible(exam))
        throw new ForbiddenException('Results have not been released yet');
    }
    const attempts = await this.prisma.exam_attempts.findMany({
      where: {
        exam_id: examId,
        status: { in: [...FINISHED_STATUSES] },
        batch_id:
          query.batchId === undefined ? undefined : BigInt(query.batchId),
      },
      include: {
        enrollments: {
          select: {
            student_user_id: true,
            student_profiles: {
              select: { users: { select: { full_name: true } } },
            },
          },
        },
      },
    });
    const ranked = rankAttempts(
      selectRankedAttempts(
        attempts.map((a) => ({
          id: a.id,
          studentUserId: a.enrollments.student_user_id,
          attemptNumber: a.attempt_number,
          score: a.score,
          submittedAt: a.submitted_at,
          fullName: a.enrollments.student_profiles.users.full_name,
          batchId: a.batch_id,
          maxScore: a.max_score,
          percentage: a.percentage,
        })),
        exam.ranking_attempt_policy,
      ),
    ).slice(0, query.limit ?? 100);
    return {
      exam: {
        id: exam.id,
        title: exam.title,
        ranking_attempt_policy: exam.ranking_attempt_policy,
      },
      entries: ranked.map((r) => ({
        rank: r.rank,
        student_user_id: r.studentUserId,
        full_name: r.fullName,
        batch_id: r.batchId,
        score: r.score,
        max_score: r.maxScore,
        percentage: r.percentage,
        submitted_at: r.submittedAt,
        ...(staff ? { attempt_id: r.id, attempt_number: r.attemptNumber } : {}),
      })),
    };
  }

  async invalidateAttempt(attemptId: bigint, user: AuthUser) {
    const attempt = await this.prisma.exam_attempts.findUnique({
      where: { id: attemptId },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    await this.assertCanManage(user, attempt.exam_id);
    if (attempt.status === 'INVALIDATED')
      throw new ConflictException('The attempt is already invalidated');
    return this.prisma.exam_attempts.update({
      where: { id: attemptId },
      data: { status: 'INVALIDATED' },
    });
  }

  /** The student's ACTIVE enrollments in batches attached to the exam. */
  studentEnrollments(user: AuthUser, examId: bigint) {
    if (!hasRole(user, RoleCode.STUDENT)) return Promise.resolve([]);
    return this.prisma.enrollments.findMany({
      where: {
        student_user_id: user.id,
        ...currentEnrollmentWhere(),
        batches: { exam_batches: { some: { exam_id: examId } } },
      },
    });
  }

  // ---- Helpers ----

  private async assertStatusChange(
    exam: exams,
    status: exams['status'],
  ): Promise<void> {
    if (status === 'PUBLISHED') {
      const [questions, batches] = await Promise.all([
        this.prisma.exam_questions.count({ where: { exam_id: exam.id } }),
        this.prisma.exam_batches.count({ where: { exam_id: exam.id } }),
      ]);
      if (!questions || !batches)
        throw new BadRequestException(
          'An exam needs at least one question and one batch before publishing',
        );
      if (!exam.total_marks.gt(0))
        throw new BadRequestException(
          'An exam needs total marks above 0 before publishing',
        );
    }
    if (status === 'DRAFT') {
      await this.assertNoAttempts(
        exam.id,
        'Students have attempted this exam; it cannot go back to DRAFT',
      );
    }
  }

  private async assertQuestionsEditable(examId: bigint): Promise<void> {
    await this.assertNoAttempts(
      examId,
      'Students have attempted this exam; its questions and marks are locked',
    );
  }

  private async assertNoAttempts(
    examId: bigint,
    message: string,
  ): Promise<void> {
    const attempts = await this.prisma.exam_attempts.count({
      where: { exam_id: examId },
    });
    if (attempts) throw new ConflictException(message);
  }

  private async assertCourseSubject(
    courseId: number,
    subjectId?: number | null,
  ): Promise<void> {
    const course = await this.prisma.courses.findUnique({
      where: { id: BigInt(courseId) },
      select: { id: true },
    });
    if (!course)
      throw new BadRequestException('courseId does not match any course');
    if (subjectId === undefined || subjectId === null) return;
    const cs = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: BigInt(courseId),
          subject_id: BigInt(subjectId),
        },
      },
    });
    if (!cs)
      throw new BadRequestException(
        'subjectId is not one of the course’s subjects',
      );
  }
}

/** Mirrors chk_exam_window. */
function assertWindow(opensAt?: Date | null, closesAt?: Date | null): void {
  if (opensAt && closesAt && closesAt <= opensAt)
    throw new BadRequestException('closesAt must be after opensAt');
}

async function recomputeTotal(
  tx: Prisma.TransactionClient,
  examId: bigint,
): Promise<void> {
  const sum = await tx.exam_questions.aggregate({
    where: { exam_id: examId },
    _sum: { marks: true },
  });
  await tx.exams.update({
    where: { id: examId },
    data: { total_marks: sum._sum.marks ?? toDecimal(0) },
  });
}
