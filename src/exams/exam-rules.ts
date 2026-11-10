import { Prisma } from '../generated/prisma/client.js';
import type { exams_ranking_attempt_policy } from '../generated/prisma/enums.js';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

export const FINISHED_STATUSES = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

export interface AnswerToGrade {
  selectedOptionId: bigint | null;
  correctOptionId: bigint | null;
  marks: Decimal;
  negativeMarks: Decimal;
}

export interface GradedAnswer {
  /** null when unanswered */
  isCorrect: boolean | null;
  marksAwarded: Decimal;
}

export interface GradeResult {
  answers: GradedAnswer[];
  correct: number;
  wrong: number;
  unanswered: number;
  score: Decimal;
  percentage: Decimal;
}

/**
 * Correct answer: +marks. Wrong answer: -negative_marks. Unanswered: 0.
 * The total is NOT floored at zero: like JEE/NEET, heavy negative marking can produce a
 * negative score (score and percentage columns are signed). Percentage is rounded half-up
 * to 2 decimals. All arithmetic uses Decimal, never floats.
 */
export function gradeAnswers(
  answers: AnswerToGrade[],
  maxScore: Decimal,
): GradeResult {
  let score = new Decimal(0);
  let correct = 0;
  let wrong = 0;
  let unanswered = 0;
  const graded = answers.map((answer): GradedAnswer => {
    if (answer.selectedOptionId === null) {
      unanswered += 1;
      return { isCorrect: null, marksAwarded: new Decimal(0) };
    }
    if (
      answer.correctOptionId !== null &&
      answer.selectedOptionId === answer.correctOptionId
    ) {
      correct += 1;
      score = score.plus(answer.marks);
      return { isCorrect: true, marksAwarded: new Decimal(answer.marks) };
    }
    wrong += 1;
    const penalty = new Decimal(answer.negativeMarks).negated();
    score = score.plus(penalty);
    return { isCorrect: false, marksAwarded: penalty };
  });
  const percentage = maxScore.gt(0)
    ? score.div(maxScore).mul(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);
  return {
    answers: graded,
    correct,
    wrong,
    unanswered,
    score: score.toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    percentage,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankableAttempt {
  id: bigint;
  studentUserId: bigint;
  attemptNumber: number;
  score: Decimal | null;
  submittedAt: Date | null;
}

/** Picks one attempt per student according to the exam's ranking policy. */
export function selectRankedAttempts<T extends RankableAttempt>(
  attempts: T[],
  policy: exams_ranking_attempt_policy,
): T[] {
  const byStudent = new Map<bigint, T>();
  for (const attempt of attempts) {
    const current = byStudent.get(attempt.studentUserId);
    if (!current || prefer(attempt, current, policy))
      byStudent.set(attempt.studentUserId, attempt);
  }
  return [...byStudent.values()];
}

function prefer(
  candidate: RankableAttempt,
  current: RankableAttempt,
  policy: exams_ranking_attempt_policy,
): boolean {
  switch (policy) {
    case 'FIRST':
      return candidate.attemptNumber < current.attemptNumber;
    case 'LATEST':
      return candidate.attemptNumber > current.attemptNumber;
    case 'BEST': {
      const cmp = scoreOf(candidate).cmp(scoreOf(current));
      return cmp > 0 || (cmp === 0 && timeOf(candidate) < timeOf(current));
    }
  }
}

const scoreOf = (a: RankableAttempt) => a.score ?? new Decimal(0);
const timeOf = (a: RankableAttempt) =>
  a.submittedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;

/** Highest score first; ties go to whoever submitted earlier. Rank is the 1-based position. */
export function rankAttempts<T extends RankableAttempt>(
  attempts: T[],
): (T & { rank: number })[] {
  return [...attempts]
    .sort((a, b) => scoreOf(b).cmp(scoreOf(a)) || timeOf(a) - timeOf(b))
    .map((attempt, index) => ({ ...attempt, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// Windows, attempts and visibility
// ---------------------------------------------------------------------------

export type WindowState = 'UPCOMING' | 'OPEN' | 'CLOSED';

export function examWindowState(
  exam: { opens_at: Date | null; closes_at: Date | null },
  now = new Date(),
): WindowState {
  if (exam.closes_at && now >= exam.closes_at) return 'CLOSED';
  if (exam.opens_at && now < exam.opens_at) return 'UPCOMING';
  return 'OPEN';
}

/** The attempt ends after the duration or when the exam window closes, whichever is first. */
export function attemptExpiry(
  startedAt: Date,
  durationMinutes: number,
  closesAt: Date | null,
): Date {
  const byDuration = new Date(startedAt.getTime() + durationMinutes * 60_000);
  return closesAt && closesAt < byDuration ? closesAt : byDuration;
}

export function resultsVisible(
  exam: { show_result_immediately: boolean; results_release_at: Date | null },
  now = new Date(),
): boolean {
  return (
    exam.show_result_immediately ||
    (!!exam.results_release_at && now >= exam.results_release_at)
  );
}

/** Correct answers and explanations: only after the review release time, and never before results. */
export function reviewVisible(
  exam: {
    show_result_immediately: boolean;
    results_release_at: Date | null;
    answer_review_release_at: Date | null;
  },
  now = new Date(),
): boolean {
  return (
    resultsVisible(exam, now) &&
    !!exam.answer_review_release_at &&
    now >= exam.answer_review_release_at
  );
}

/** Fisher-Yates shuffle (question order differs per attempt). */
export function shuffle<T>(
  items: T[],
  random: () => number = Math.random,
): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function toDecimal(value: number | string): Decimal {
  return new Decimal(String(value));
}
