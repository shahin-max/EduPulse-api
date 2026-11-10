import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { exam_attempts, exams } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { currentEnrollmentWhere } from '../common/access.service.js';
import { AuthUser } from '../common/auth.js';
import { ExamsService } from './exams.service.js';
import {
  attemptExpiry,
  examWindowState,
  gradeAnswers,
  resultsVisible,
  reviewVisible,
  shuffle,
} from './exam-rules.js';
import { SaveAnswerDto } from './dto/exams.dto.js';

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

@Injectable()
export class AttemptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly exams: ExamsService,
  ) {}

  /** Exams for the student's batches that are published and not yet closed. */
  async available(user: AuthUser) {
    const enrollments = await this.prisma.enrollments.findMany({
      where: { student_user_id: user.id, ...currentEnrollmentWhere() },
      select: { id: true, batch_id: true },
    });
    const now = new Date();
    const exams = await this.prisma.exams.findMany({
      where: {
        status: 'PUBLISHED',
        exam_batches: {
          some: { batch_id: { in: enrollments.map((e) => e.batch_id) } },
        },
        OR: [{ closes_at: null }, { closes_at: { gt: now } }],
      },
      include: {
        courses: { select: { id: true, code: true, title: true } },
        subjects: { select: { id: true, code: true, name: true } },
        _count: { select: { exam_questions: true } },
      },
      orderBy: [{ opens_at: 'asc' }, { id: 'asc' }],
    });
    const attempts = await this.prisma.exam_attempts.findMany({
      where: {
        enrollment_id: { in: enrollments.map((e) => e.id) },
        exam_id: { in: exams.map((e) => e.id) },
      },
      select: { exam_id: true, status: true, id: true, expires_at: true },
    });
    return exams.map(({ created_by: _c, ...exam }) => {
      const mine = attempts.filter((a) => a.exam_id === exam.id);
      const used = mine.filter((a) => a.status !== 'INVALIDATED').length;
      const inProgress = mine.find(
        (a) => a.status === 'IN_PROGRESS' && a.expires_at > now,
      );
      return {
        ...exam,
        window: examWindowState(exam, now),
        attempts_used: used,
        attempts_remaining: Math.max(exam.max_attempts - used, 0),
        in_progress_attempt_id: inProgress?.id ?? null,
      };
    });
  }

  /** Starts an attempt; one IN_PROGRESS attempt at a time, within the window and the attempt limit. */
  async start(examId: bigint, user: AuthUser, batchId?: number) {
    const exam = await this.exams.getExam(examId);
    if (exam.status !== 'PUBLISHED')
      throw new BadRequestException('This exam is not open');
    const now = new Date();
    const window = examWindowState(exam, now);
    if (window === 'UPCOMING')
      throw new BadRequestException('This exam has not opened yet');
    if (window === 'CLOSED')
      throw new BadRequestException('This exam has closed');

    const enrollments = (
      await this.exams.studentEnrollments(user, examId)
    ).filter((e) => batchId === undefined || e.batch_id === BigInt(batchId));
    if (!enrollments.length)
      throw new ForbiddenException(
        'You are not enrolled in a batch taking this exam',
      );
    if (enrollments.length > 1)
      throw new BadRequestException(
        'You are in several batches taking this exam; pass batchId',
      );
    const enrollment = enrollments[0];
    if (
      (enrollment.access_starts_at && now < enrollment.access_starts_at) ||
      (enrollment.access_ends_at && now >= enrollment.access_ends_at)
    ) {
      throw new ForbiddenException(
        'Your access to this batch is not active right now',
      );
    }
    if (!exam.total_marks.gt(0))
      throw new BadRequestException('This exam has no marks yet');

    const attemptId = await this.prisma.$transaction(async (tx) => {
      // Serialise attempt starts for this enrollment.
      await tx.$queryRaw`SELECT id FROM enrollments WHERE id = ${enrollment.id} FOR UPDATE`;
      const previous = await tx.exam_attempts.findMany({
        where: { exam_id: examId, enrollment_id: enrollment.id },
      });
      for (const attempt of previous)
        await this.finalizeIfExpired(tx, attempt, now);
      const refreshed = await tx.exam_attempts.findMany({
        where: { exam_id: examId, enrollment_id: enrollment.id },
      });
      if (refreshed.some((a) => a.status === 'IN_PROGRESS'))
        throw new ConflictException('You already have an attempt in progress');
      const used = refreshed.filter((a) => a.status !== 'INVALIDATED').length;
      if (used >= exam.max_attempts)
        throw new ConflictException(
          'You have used all your attempts for this exam',
        );

      const questions = await tx.exam_questions.findMany({
        where: { exam_id: examId },
        select: { question_id: true },
      });
      const attempt = await tx.exam_attempts.create({
        data: {
          exam_id: examId,
          batch_id: enrollment.batch_id,
          enrollment_id: enrollment.id,
          attempt_number:
            Math.max(0, ...refreshed.map((a) => a.attempt_number)) + 1,
          started_at: now,
          expires_at: attemptExpiry(now, exam.duration_minutes, exam.closes_at),
          max_score: exam.total_marks,
          unanswered_count: questions.length,
        },
      });
      // Question order is shuffled per attempt; option labels (A, B, ...) keep their order.
      await tx.attempt_answers.createMany({
        data: shuffle(questions).map((q, index) => ({
          attempt_id: attempt.id,
          exam_id: examId,
          question_id: q.question_id,
          display_order: index + 1,
        })),
      });
      return attempt.id;
    });
    return this.view(attemptId, user);
  }

  /** The attempt with its questions. Expired attempts are auto-submitted first. */
  async get(attemptId: bigint, user: AuthUser) {
    const { attempt } = await this.loadFor(attemptId, user);
    await this.finalizeIfExpired(this.prisma, attempt);
    return this.view(attemptId, user);
  }

  async mine(user: AuthUser, examId?: number) {
    const attempts = await this.prisma.exam_attempts.findMany({
      where: {
        enrollments: { student_user_id: user.id },
        exam_id: examId === undefined ? undefined : BigInt(examId),
      },
      include: { exams: true },
      orderBy: { id: 'desc' },
    });
    for (const attempt of attempts)
      await this.finalizeIfExpired(this.prisma, attempt);
    const fresh = await this.prisma.exam_attempts.findMany({
      where: { id: { in: attempts.map((a) => a.id) } },
      include: {
        exams: {
          select: {
            id: true,
            title: true,
            kind: true,
            show_result_immediately: true,
            results_release_at: true,
          },
        },
      },
      orderBy: { id: 'desc' },
    });
    return fresh.map((a) => summarise(a, a.exams, false));
  }

  async saveAnswer(
    attemptId: bigint,
    questionId: bigint,
    dto: SaveAnswerDto,
    user: AuthUser,
  ) {
    const { attempt } = await this.loadFor(attemptId, user, true);
    if (await this.finalizeIfExpired(this.prisma, attempt))
      throw new ConflictException('Time is up; the attempt was submitted');
    if (attempt.status !== 'IN_PROGRESS')
      throw new ConflictException('This attempt is no longer in progress');
    const answer = await this.prisma.attempt_answers.findUnique({
      where: {
        attempt_id_question_id: {
          attempt_id: attemptId,
          question_id: questionId,
        },
      },
    });
    if (!answer)
      throw new NotFoundException('This question is not part of the attempt');
    if (dto.selectedOptionId !== undefined && dto.selectedOptionId !== null) {
      const option = await this.prisma.question_options.findUnique({
        where: { id: BigInt(dto.selectedOptionId) },
        select: { question_id: true },
      });
      if (!option || option.question_id !== questionId)
        throw new BadRequestException(
          'selectedOptionId is not an option of this question',
        );
    }
    const updated = await this.prisma.attempt_answers.update({
      where: {
        attempt_id_question_id: {
          attempt_id: attemptId,
          question_id: questionId,
        },
      },
      data: {
        ...(dto.selectedOptionId === undefined
          ? {}
          : {
              selected_option_id:
                dto.selectedOptionId === null
                  ? null
                  : BigInt(dto.selectedOptionId),
              answered_at: dto.selectedOptionId === null ? null : new Date(),
            }),
        is_marked_for_review: dto.isMarkedForReview,
      },
    });
    return {
      question_id: updated.question_id,
      selected_option_id: updated.selected_option_id,
      is_marked_for_review: updated.is_marked_for_review,
      answered_at: updated.answered_at,
      seconds_remaining: secondsRemaining(attempt.expires_at),
    };
  }

  async submit(attemptId: bigint, user: AuthUser) {
    const { attempt } = await this.loadFor(attemptId, user, true);
    if (!(await this.finalizeIfExpired(this.prisma, attempt))) {
      if (attempt.status !== 'IN_PROGRESS')
        throw new ConflictException('This attempt has already been submitted');
      await this.prisma.$transaction((tx) =>
        this.finalize(tx, attempt, 'SUBMITTED', new Date()),
      );
    }
    return this.view(attemptId, user);
  }

  // ---- Grading ----

  /** Grades and closes an expired IN_PROGRESS attempt as AUTO_SUBMITTED. Returns true if it did. */
  async finalizeIfExpired(
    db: Db,
    attempt: exam_attempts,
    now = new Date(),
  ): Promise<boolean> {
    if (attempt.status !== 'IN_PROGRESS' || attempt.expires_at > now)
      return false;
    const run = (tx: Tx) =>
      this.finalize(tx, attempt, 'AUTO_SUBMITTED', attempt.expires_at);
    if ('$transaction' in db) await db.$transaction(run);
    else await run(db);
    return true;
  }

  /** Scores every answer and closes the attempt, unless another request already did. */
  private async finalize(
    tx: Tx,
    attempt: exam_attempts,
    status: 'SUBMITTED' | 'AUTO_SUBMITTED',
    submittedAt: Date,
  ): Promise<void> {
    const answers = await tx.attempt_answers.findMany({
      where: { attempt_id: attempt.id },
      include: {
        exam_questions: { select: { marks: true, negative_marks: true } },
      },
    });
    const correctOptions = await tx.question_options.findMany({
      where: {
        question_id: { in: answers.map((a) => a.question_id) },
        is_correct: true,
      },
      select: { id: true, question_id: true },
    });
    const correctByQuestion = new Map(
      correctOptions.map((o) => [o.question_id, o.id]),
    );
    const result = gradeAnswers(
      answers.map((a) => ({
        selectedOptionId: a.selected_option_id,
        correctOptionId: correctByQuestion.get(a.question_id) ?? null,
        marks: a.exam_questions.marks,
        negativeMarks: a.exam_questions.negative_marks,
      })),
      attempt.max_score,
    );
    const { count } = await tx.exam_attempts.updateMany({
      where: { id: attempt.id, status: 'IN_PROGRESS' },
      data: {
        status,
        submitted_at:
          submittedAt < attempt.started_at ? attempt.started_at : submittedAt,
        correct_count: result.correct,
        wrong_count: result.wrong,
        unanswered_count: result.unanswered,
        score: result.score,
        percentage: result.percentage,
        graded_at: new Date(),
      },
    });
    if (count !== 1) return; // someone else finalised it first
    for (const [index, answer] of answers.entries()) {
      await tx.attempt_answers.update({
        where: {
          attempt_id_question_id: {
            attempt_id: attempt.id,
            question_id: answer.question_id,
          },
        },
        data: {
          is_correct: result.answers[index].isCorrect,
          marks_awarded: result.answers[index].marksAwarded,
        },
      });
    }
  }

  // ---- Views ----

  /** Students may only open their own attempts; staff need to manage the exam. */
  private async loadFor(attemptId: bigint, user: AuthUser, ownerOnly = false) {
    const attempt = await this.prisma.exam_attempts.findUnique({
      where: { id: attemptId },
      include: { enrollments: { select: { student_user_id: true } } },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    const owner = attempt.enrollments.student_user_id === user.id;
    if (!owner) {
      if (ownerOnly) throw new ForbiddenException('This is not your attempt');
      const exam = await this.exams.getExam(attempt.exam_id);
      if (!(await this.exams.canManage(user, exam)))
        throw new NotFoundException('Attempt not found');
    }
    const { enrollments: _e, ...plain } = attempt;
    return { attempt: plain, owner };
  }

  private async view(attemptId: bigint, user: AuthUser) {
    const attempt = await this.prisma.exam_attempts.findUniqueOrThrow({
      where: { id: attemptId },
      include: {
        exams: true,
        enrollments: { select: { student_user_id: true } },
        attempt_answers: {
          orderBy: { display_order: 'asc' },
          include: {
            exam_questions: {
              select: {
                marks: true,
                negative_marks: true,
                questions: {
                  select: {
                    question_text: true,
                    explanation: true,
                    question_options: {
                      orderBy: [{ sort_order: 'asc' }, { option_label: 'asc' }],
                      select: {
                        id: true,
                        option_label: true,
                        option_text: true,
                        is_correct: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const staff = attempt.enrollments.student_user_id !== user.id;
    const finished = attempt.status !== 'IN_PROGRESS';
    const showResult = staff || (finished && resultsVisible(attempt.exams));
    const showReview = staff || (finished && reviewVisible(attempt.exams));
    return {
      ...summarise(attempt, attempt.exams, staff),
      results_visible: showResult,
      review_visible: showReview,
      seconds_remaining:
        attempt.status === 'IN_PROGRESS'
          ? secondsRemaining(attempt.expires_at)
          : 0,
      questions: attempt.attempt_answers.map((a) => ({
        question_id: a.question_id,
        display_order: a.display_order,
        question_text: a.exam_questions.questions.question_text,
        marks: a.exam_questions.marks,
        negative_marks: a.exam_questions.negative_marks,
        options: a.exam_questions.questions.question_options.map((o) => ({
          id: o.id,
          option_label: o.option_label,
          option_text: o.option_text,
          ...(showReview ? { is_correct: o.is_correct } : {}),
        })),
        selected_option_id: a.selected_option_id,
        is_marked_for_review: a.is_marked_for_review,
        answered_at: a.answered_at,
        ...(showReview
          ? {
              is_correct: a.is_correct,
              marks_awarded: a.marks_awarded,
              explanation: a.exam_questions.questions.explanation,
            }
          : {}),
      })),
    };
  }
}

function secondsRemaining(expiresAt: Date): number {
  return Math.max(Math.floor((expiresAt.getTime() - Date.now()) / 1000), 0);
}

/** Attempt header; score fields only when results are visible to this viewer. */
function summarise(
  attempt: exam_attempts,
  exam: Pick<
    exams,
    'id' | 'title' | 'kind' | 'show_result_immediately' | 'results_release_at'
  >,
  staff: boolean,
) {
  const showResult =
    staff || (attempt.status !== 'IN_PROGRESS' && resultsVisible(exam));
  return {
    id: attempt.id,
    exam: { id: exam.id, title: exam.title, kind: exam.kind },
    batch_id: attempt.batch_id,
    enrollment_id: attempt.enrollment_id,
    attempt_number: attempt.attempt_number,
    status: attempt.status,
    started_at: attempt.started_at,
    expires_at: attempt.expires_at,
    submitted_at: attempt.submitted_at,
    max_score: attempt.max_score,
    ...(showResult
      ? {
          score: attempt.score,
          percentage: attempt.percentage,
          correct_count: attempt.correct_count,
          wrong_count: attempt.wrong_count,
          unanswered_count: attempt.unanswered_count,
          graded_at: attempt.graded_at,
        }
      : {}),
  };
}
