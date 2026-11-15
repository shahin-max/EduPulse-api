import { PrismaService } from '../prisma/prisma.service.js';
import { resultsVisible } from '../exams/exam-rules.js';

const GRADED = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;

export type SubjectPerformance = {
  subject: { id: bigint; name: string };
  /** From each test's best graded attempt, counted per question. Null when no test touched the subject. */
  tests: {
    score: number;
    max: number;
    percentage: number | null;
    questions: number;
    correct: number;
    wrong: number;
    unanswered: number;
    tests: number;
  } | null;
  /** Reviewed assignments of the subject that have marks out of a maximum. */
  assignments: {
    marks: number;
    max: number;
    percentage: number | null;
    count: number;
  } | null;
};

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-subject results for a student's enrollments. Each question of a test belongs to a subject
 * (through its course subject), so a mixed test counts towards every subject it covers. For each
 * test only the best graded attempt counts (highest percentage), like the gradebook. With
 * `studentView`, tests whose results are not released yet are left out.
 */
export async function subjectPerformance(
  prisma: PrismaService,
  enrollmentIds: bigint[],
  { studentView }: { studentView: boolean },
): Promise<SubjectPerformance[]> {
  if (!enrollmentIds.length) return [];
  const [attempts, submissions] = await Promise.all([
    prisma.exam_attempts.findMany({
      where: {
        enrollment_id: { in: enrollmentIds },
        status: { in: [...GRADED] },
      },
      select: {
        id: true,
        exam_id: true,
        percentage: true,
        exams: {
          select: { show_result_immediately: true, results_release_at: true },
        },
      },
    }),
    prisma.assignment_submissions.findMany({
      where: {
        enrollment_id: { in: enrollmentIds },
        reviewed_at: { not: null },
        marks_awarded: { not: null },
        assignments: { max_marks: { not: null }, subject_id: { not: null } },
      },
      select: {
        marks_awarded: true,
        assignments: {
          select: {
            max_marks: true,
            subjects: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  // Best graded attempt per test.
  const best = new Map<bigint, (typeof attempts)[number]>();
  for (const a of attempts) {
    if (studentView && !resultsVisible(a.exams)) continue;
    const current = best.get(a.exam_id);
    if (
      !current ||
      Number(a.percentage ?? -1) > Number(current.percentage ?? -1)
    )
      best.set(a.exam_id, a);
  }

  const answers = best.size
    ? await prisma.attempt_answers.findMany({
        where: { attempt_id: { in: [...best.values()].map((a) => a.id) } },
        select: {
          exam_id: true,
          selected_option_id: true,
          is_correct: true,
          marks_awarded: true,
          exam_questions: {
            select: {
              marks: true,
              questions: {
                select: {
                  course_subjects: {
                    select: { subjects: { select: { id: true, name: true } } },
                  },
                },
              },
            },
          },
        },
      })
    : [];

  const bySubject = new Map<
    bigint,
    {
      subject: { id: bigint; name: string };
      t?: NonNullable<SubjectPerformance['tests']> & { exams: Set<bigint> };
      a?: NonNullable<SubjectPerformance['assignments']>;
    }
  >();
  const entry = (subject: { id: bigint; name: string }) => {
    let e = bySubject.get(subject.id);
    if (!e) bySubject.set(subject.id, (e = { subject }));
    return e;
  };

  for (const ans of answers) {
    const e = entry(ans.exam_questions.questions.course_subjects.subjects);
    e.t ??= {
      score: 0,
      max: 0,
      percentage: null,
      questions: 0,
      correct: 0,
      wrong: 0,
      unanswered: 0,
      tests: 0,
      exams: new Set(),
    };
    e.t.score += Number(ans.marks_awarded ?? 0);
    e.t.max += Number(ans.exam_questions.marks);
    e.t.questions += 1;
    if (ans.selected_option_id === null) e.t.unanswered += 1;
    else if (ans.is_correct) e.t.correct += 1;
    else e.t.wrong += 1;
    e.t.exams.add(ans.exam_id);
  }
  for (const s of submissions) {
    const subject = s.assignments.subjects;
    if (!subject) continue;
    const e = entry(subject);
    e.a ??= { marks: 0, max: 0, percentage: null, count: 0 };
    e.a.marks += Number(s.marks_awarded);
    e.a.max += Number(s.assignments.max_marks);
    e.a.count += 1;
  }

  return [...bySubject.values()]
    .map(({ subject, t, a }) => ({
      subject,
      tests: t
        ? {
            score: round2(t.score),
            max: round2(t.max),
            // Negative marking can push a subject below zero; the share is still reported as is.
            percentage: pct(t.score, t.max),
            questions: t.questions,
            correct: t.correct,
            wrong: t.wrong,
            unanswered: t.unanswered,
            tests: t.exams.size,
          }
        : null,
      assignments: a
        ? {
            marks: round2(a.marks),
            max: round2(a.max),
            percentage: pct(a.marks, a.max),
            count: a.count,
          }
        : null,
    }))
    .sort((x, y) => x.subject.name.localeCompare(y.subject.name));
}
