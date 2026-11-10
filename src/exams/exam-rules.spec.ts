import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  attemptExpiry,
  examWindowState,
  gradeAnswers,
  rankAttempts,
  resultsVisible,
  reviewVisible,
  selectRankedAttempts,
  shuffle,
} from './exam-rules.js';
import { assertOptions } from './questions.service.js';

const D = (v: string | number) => new Prisma.Decimal(String(v));

describe('gradeAnswers', () => {
  const q = (
    selected: number | null,
    correct: number,
    marks = '4',
    negative = '1',
  ) => ({
    selectedOptionId: selected === null ? null : BigInt(selected),
    correctOptionId: BigInt(correct),
    marks: D(marks),
    negativeMarks: D(negative),
  });

  it('awards marks, deducts negative marks and ignores unanswered questions', () => {
    const result = gradeAnswers([q(1, 1), q(2, 1), q(null, 1), q(5, 5)], D(16));
    expect(result.correct).toBe(2);
    expect(result.wrong).toBe(1);
    expect(result.unanswered).toBe(1);
    expect(result.score.toString()).toBe('7');
    expect(result.percentage.toString()).toBe('43.75');
    expect(
      result.answers.map((a) => [a.isCorrect, a.marksAwarded.toString()]),
    ).toEqual([
      [true, '4'],
      [false, '-1'],
      [null, '0'],
      [true, '4'],
    ]);
  });

  it('uses exact decimal arithmetic (no float drift)', () => {
    const answers = Array.from({ length: 3 }, () => q(1, 1, '0.1', '0'));
    const result = gradeAnswers(answers, D('0.3'));
    expect(result.score.toString()).toBe('0.3');
    expect(result.percentage.toString()).toBe('100');
  });

  it('allows a negative total (no floor at zero), like JEE/NEET', () => {
    const result = gradeAnswers([q(2, 1), q(2, 1), q(null, 1)], D(12));
    expect(result.score.toString()).toBe('-2');
    expect(result.percentage.toString()).toBe('-16.67');
  });

  it('rounds the percentage half-up to 2 decimals', () => {
    const result = gradeAnswers(
      [q(1, 1, '1', '0'), q(null, 1, '1'), q(null, 1, '1')],
      D(3),
    );
    expect(result.percentage.toString()).toBe('33.33');
    const twoThirds = gradeAnswers(
      [q(1, 1, '1', '0'), q(1, 1, '1', '0'), q(null, 1, '1')],
      D(3),
    );
    expect(twoThirds.percentage.toString()).toBe('66.67');
  });
});

describe('ranking', () => {
  const at = (
    id: number,
    student: number,
    n: number,
    score: string | null,
    minute: number,
  ) => ({
    id: BigInt(id),
    studentUserId: BigInt(student),
    attemptNumber: n,
    score: score === null ? null : D(score),
    submittedAt: new Date(Date.UTC(2027, 0, 1, 10, minute)),
  });
  const attempts = [
    at(1, 10, 1, '20', 5),
    at(2, 10, 2, '35', 50),
    at(3, 10, 3, '30', 55),
    at(4, 11, 1, '35', 40),
  ];
  const pick = (policy: 'FIRST' | 'BEST' | 'LATEST') =>
    selectRankedAttempts(attempts, policy)
      .map((a) => Number(a.id))
      .sort((a, b) => a - b);

  it('FIRST keeps the earliest attempt number per student', () =>
    expect(pick('FIRST')).toEqual([1, 4]));
  it('LATEST keeps the highest attempt number per student', () =>
    expect(pick('LATEST')).toEqual([3, 4]));
  it('BEST keeps the highest score per student', () =>
    expect(pick('BEST')).toEqual([2, 4]));

  it('BEST breaks equal scores by the earlier submission', () => {
    const tie = [at(1, 10, 1, '30', 50), at(2, 10, 2, '30', 10)];
    expect(selectRankedAttempts(tie, 'BEST').map((a) => Number(a.id))).toEqual([
      2,
    ]);
  });

  it('ranks by score, then earlier submission', () => {
    const ranked = rankAttempts(selectRankedAttempts(attempts, 'BEST'));
    // Both scored 35; student 11 submitted at :40, student 10 at :50.
    expect(ranked.map((r) => [Number(r.studentUserId), r.rank])).toEqual([
      [11, 1],
      [10, 2],
    ]);
  });
});

describe('windows and visibility', () => {
  const now = new Date('2027-01-10T10:00:00Z');

  it('classifies the exam window', () => {
    expect(examWindowState({ opens_at: null, closes_at: null }, now)).toBe(
      'OPEN',
    );
    expect(
      examWindowState(
        { opens_at: new Date('2027-01-10T11:00:00Z'), closes_at: null },
        now,
      ),
    ).toBe('UPCOMING');
    expect(
      examWindowState(
        { opens_at: null, closes_at: new Date('2027-01-10T10:00:00Z') },
        now,
      ),
    ).toBe('CLOSED');
  });

  it('ends an attempt at the duration or the window close, whichever is first', () => {
    expect(attemptExpiry(now, 60, null).toISOString()).toBe(
      '2027-01-10T11:00:00.000Z',
    );
    expect(
      attemptExpiry(now, 60, new Date('2027-01-10T10:30:00Z')).toISOString(),
    ).toBe('2027-01-10T10:30:00.000Z');
  });

  it('shows results immediately or after the release time', () => {
    expect(
      resultsVisible(
        { show_result_immediately: true, results_release_at: null },
        now,
      ),
    ).toBe(true);
    expect(
      resultsVisible(
        { show_result_immediately: false, results_release_at: null },
        now,
      ),
    ).toBe(false);
    expect(
      resultsVisible(
        {
          show_result_immediately: false,
          results_release_at: new Date('2027-01-10T09:00:00Z'),
        },
        now,
      ),
    ).toBe(true);
  });

  it('never reveals answers before results, nor before the review release time', () => {
    const base = { show_result_immediately: true, results_release_at: null };
    expect(
      reviewVisible({ ...base, answer_review_release_at: null }, now),
    ).toBe(false);
    expect(
      reviewVisible(
        { ...base, answer_review_release_at: new Date('2027-01-11T00:00:00Z') },
        now,
      ),
    ).toBe(false);
    expect(
      reviewVisible(
        { ...base, answer_review_release_at: new Date('2027-01-09T00:00:00Z') },
        now,
      ),
    ).toBe(true);
    expect(
      reviewVisible(
        {
          show_result_immediately: false,
          results_release_at: null,
          answer_review_release_at: new Date('2027-01-09T00:00:00Z'),
        },
        now,
      ),
    ).toBe(false);
  });

  it('shuffles without losing or duplicating items', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffle(items);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(0); // input untouched
  });
});

describe('assertOptions', () => {
  const opt = (label: string, isCorrect: boolean) => ({
    optionLabel: label,
    optionText: label,
    isCorrect,
  });

  it('accepts exactly one correct option with unique labels', () => {
    expect(() =>
      assertOptions([opt('A', true), opt('B', false)]),
    ).not.toThrow();
  });
  it('rejects zero or several correct options', () => {
    expect(() => assertOptions([opt('A', false), opt('B', false)])).toThrow(
      BadRequestException,
    );
    expect(() => assertOptions([opt('A', true), opt('B', true)])).toThrow(
      /exactly one/,
    );
  });
  it('rejects duplicate labels', () => {
    expect(() => assertOptions([opt('A', true), opt('A', false)])).toThrow(
      /unique/,
    );
  });
});
