import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser } from '../common/auth.js';
import { NotificationsService } from '../communications/notifications.service.js';
import { examWindowState } from '../exams/exam-rules.js';
import {
  CreateScholarshipTestDto,
  JoinScholarshipTestDto,
  OverrideAwardDto,
  ScholarshipSlabDto,
  UpdateScholarshipTestDto,
} from './scholarships.dto.js';

/** The hidden catalogue course that holds every Scholarship Test's questions, batch and exam. */
const COURSE = {
  code: 'SCHOLARSHIP',
  slug: 'scholarship-tests',
  title: 'Scholarship Tests',
  description:
    'Internal course for Scholarship Test papers. Kept as a draft so it never appears on the website.',
};
const GRADED = ['SUBMITTED', 'AUTO_SUBMITTED'] as const;

export type Slab = { minPercentage: number; discountPercent: number };

/** Highest slab the percentage reaches (slabs in any order); 0 when none. */
export function discountFor(percentage: number | null, slabs: Slab[]): number {
  if (percentage === null) return 0;
  let best = 0;
  for (const s of slabs)
    if (percentage >= s.minPercentage && s.discountPercent > best)
      best = s.discountPercent;
  return best;
}

function normaliseSlabs(slabs: ScholarshipSlabDto[]): Slab[] {
  const out = slabs
    .map((s) => ({
      minPercentage: s.minPercentage,
      discountPercent: s.discountPercent,
    }))
    .sort((a, b) => b.minPercentage - a.minPercentage);
  if (new Set(out.map((s) => s.minPercentage)).size !== out.length)
    throw new BadRequestException(
      'Each slab needs a different minimum percentage',
    );
  return out;
}

const grades = (csv: string | null) =>
  csv
    ? csv
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : [];

const testInclude = {
  exams: {
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      duration_minutes: true,
      total_marks: true,
      opens_at: true,
      closes_at: true,
      _count: { select: { exam_questions: true } },
    },
  },
  batches: { select: { id: true, code: true, name: true } },
} satisfies Prisma.scholarship_testsInclude;

/**
 * Scholarship Tests: registration, an online test in the student portal (the exam engine), marking,
 * ranking, score slabs, publishing results, and awards applied once as % off a fee invoice.
 */
@Injectable()
export class ScholarshipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- admin: set-up

  /** Creates the test with its candidates batch and a draft exam (paper built in the exam builder). */
  async create(dto: CreateScholarshipTestDto, user: AuthUser) {
    const slabs = normaliseSlabs(dto.slabs);
    if (dto.closesAt <= dto.opensAt)
      throw new BadRequestException('The test must close after it opens');
    const branch = await this.prisma.branches.findFirst({
      where: { is_active: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!branch) throw new BadRequestException('Create a branch first');
    const courseId = await this.ensureCourse();
    const stamp = Date.now().toString(36).toUpperCase();

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batches.create({
        data: {
          branch_id: branch.id,
          course_id: courseId,
          code: `SCH-${stamp}`,
          name: `${dto.title} (candidates)`.slice(0, 160),
          status: 'ACTIVE',
        },
      });
      const exam = await tx.exams.create({
        data: {
          course_id: courseId,
          title: dto.title,
          kind: dto.omr ? 'OMR_PRACTICE' : 'MOCK_TEST',
          duration_minutes: dto.durationMinutes,
          max_attempts: 1,
          opens_at: dto.opensAt,
          closes_at: dto.closesAt,
          show_result_immediately: false,
          status: 'DRAFT',
          created_by: user.id,
        },
      });
      await tx.exam_batches.create({
        data: { exam_id: exam.id, batch_id: batch.id },
      });
      return tx.scholarship_tests.create({
        data: {
          title: dto.title,
          description: dto.description,
          exam_id: exam.id,
          batch_id: batch.id,
          eligible_grades: dto.eligibleGrades?.length
            ? dto.eligibleGrades.join(',')
            : null,
          slabs,
          registration_closes_at: dto.registrationClosesAt,
          valid_until: dto.validUntil,
          created_by: user.id,
        },
        include: testInclude,
      });
    });
  }

  async list() {
    const tests = await this.prisma.scholarship_tests.findMany({
      orderBy: { id: 'desc' },
      include: testInclude,
    });
    const counts = await this.candidateCounts(tests.map((t) => t.batch_id));
    return tests.map((t) => this.present(t, counts.get(t.batch_id) ?? 0));
  }

  async findOne(id: bigint) {
    const t = await this.get(id);
    const counts = await this.candidateCounts([t.batch_id]);
    return this.present(t, counts.get(t.batch_id) ?? 0);
  }

  async update(id: bigint, dto: UpdateScholarshipTestDto) {
    const t = await this.get(id);
    if (t.status === 'RESULTS_PUBLISHED' && dto.slabs)
      throw new ConflictException(
        'Results are published, so the slabs can no longer change',
      );
    await this.prisma.scholarship_tests.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        eligible_grades:
          dto.eligibleGrades === undefined
            ? undefined
            : dto.eligibleGrades.length
              ? dto.eligibleGrades.join(',')
              : null,
        slabs: dto.slabs ? normaliseSlabs(dto.slabs) : undefined,
        registration_closes_at: dto.registrationClosesAt,
        valid_until: dto.validUntil,
      },
    });
    if (dto.title)
      await this.prisma.exams.update({
        where: { id: t.exam_id },
        data: { title: dto.title },
      });
    return this.findOne(id);
  }

  /** Opens registration and publishes the exam (it can be taken inside its window). */
  async open(id: bigint) {
    const t = await this.get(id);
    if (t.status !== 'DRAFT')
      throw new ConflictException('This test is already open');
    if (!t.exams._count.exam_questions || !t.exams.total_marks.gt(0))
      throw new BadRequestException(
        'Add questions to the test paper before opening registration',
      );
    await this.prisma.$transaction([
      this.prisma.exams.update({
        where: { id: t.exam_id },
        data: { status: 'PUBLISHED' },
      }),
      this.prisma.scholarship_tests.update({
        where: { id },
        data: { status: 'OPEN' },
      }),
    ]);
    return this.findOne(id);
  }

  // ---------------------------------------------------------------- public and students

  /** `{ test }`: the test currently taking registrations (website button), or `{ test: null }`. */
  async current() {
    const now = new Date();
    const t = await this.prisma.scholarship_tests.findFirst({
      where: {
        status: 'OPEN',
        OR: [
          { registration_closes_at: null },
          { registration_closes_at: { gt: now } },
        ],
        exams: { OR: [{ closes_at: null }, { closes_at: { gt: now } }] },
      },
      orderBy: { id: 'desc' },
      include: testInclude,
    });
    if (!t) return { test: null };
    return {
      test: {
        id: t.id,
        title: t.title,
        description: t.description,
        eligible_grades: grades(t.eligible_grades),
        slabs: t.slabs as Slab[],
        registration_closes_at: t.registration_closes_at,
        valid_until: t.valid_until,
        opens_at: t.exams.opens_at,
        closes_at: t.exams.closes_at,
        duration_minutes: t.exams.duration_minutes,
      },
    };
  }

  /** A student registers: enrolled in the test's candidates batch, and an enquiry for the office. */
  async join(id: bigint, dto: JoinScholarshipTestDto, user: AuthUser) {
    const t = await this.get(id);
    const now = new Date();
    if (
      t.status !== 'OPEN' ||
      (t.registration_closes_at && t.registration_closes_at <= now)
    )
      throw new BadRequestException('Registration for this test is closed');
    if (t.exams.closes_at && t.exams.closes_at <= now)
      throw new BadRequestException('This test has already finished');
    const allowed = grades(t.eligible_grades);
    if (allowed.length && !allowed.includes(dto.grade))
      throw new BadRequestException(
        `This test is for ${allowed.join(', ')} students`,
      );

    const profile = await this.prisma.student_profiles.findUnique({
      where: { user_id: user.id },
      select: {
        grade: true,
        users: { select: { full_name: true, mobile: true, email: true } },
      },
    });
    if (!profile)
      throw new ForbiddenException('Only student accounts can register');
    const existing = await this.prisma.enrollments.findFirst({
      where: { batch_id: t.batch_id, student_user_id: user.id },
    });
    if (existing) return { registered: true, already: true, test_id: t.id };

    const batch = await this.prisma.batches.findUniqueOrThrow({
      where: { id: t.batch_id },
      select: { branch_id: true },
    });
    await this.prisma.$transaction([
      this.prisma.enrollments.create({
        data: {
          student_user_id: user.id,
          batch_id: t.batch_id,
          branch_id: batch.branch_id,
          status: 'ACTIVE',
        },
      }),
      ...(profile.grade
        ? []
        : [
            this.prisma.student_profiles.update({
              where: { user_id: user.id },
              data: { grade: dto.grade },
            }),
          ]),
      // The office sees every registration with the other enquiries (and can call back).
      ...(profile.users.mobile
        ? [
            this.prisma.admission_enquiries.create({
              data: {
                student_name: profile.users.full_name,
                mobile: profile.users.mobile,
                email: profile.users.email,
                message: `Scholarship Test registration: ${t.title}\nClass: ${dto.grade}`,
                source: 'SCHOLARSHIP_TEST',
              },
            }),
          ]
        : []),
    ]);
    return { registered: true, already: false, test_id: t.id };
  }

  /** The student's Scholarship Tests: when to take them, their attempt, and the result once published. */
  async mine(user: AuthUser) {
    const enrollments = await this.prisma.enrollments.findMany({
      where: {
        student_user_id: user.id,
        batches: { scholarship_tests: { isNot: null } },
      },
      select: { id: true, batch_id: true, status: true },
    });
    if (!enrollments.length) return [];
    const tests = await this.prisma.scholarship_tests.findMany({
      where: { batch_id: { in: enrollments.map((e) => e.batch_id) } },
      orderBy: { id: 'desc' },
      include: {
        ...testInclude,
        scholarship_awards: { where: { student_user_id: user.id } },
      },
    });
    const attempts = await this.prisma.exam_attempts.findMany({
      where: {
        exam_id: { in: tests.map((t) => t.exam_id) },
        enrollments: { student_user_id: user.id },
      },
      select: {
        id: true,
        exam_id: true,
        status: true,
        expires_at: true,
        percentage: true,
      },
    });
    const candidates = await this.candidateCounts(tests.map((t) => t.batch_id));
    const now = new Date();
    return tests.map((t) => {
      const mine = attempts.filter((a) => a.exam_id === t.exam_id);
      const inProgress = mine.find(
        (a) => a.status === 'IN_PROGRESS' && a.expires_at > now,
      );
      const award = t.scholarship_awards[0];
      const published = t.status === 'RESULTS_PUBLISHED';
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        slabs: t.slabs as Slab[],
        valid_until: t.valid_until,
        exam: {
          id: t.exam_id,
          kind: t.exams.kind,
          opens_at: t.exams.opens_at,
          closes_at: t.exams.closes_at,
          duration_minutes: t.exams.duration_minutes,
          questions: t.exams._count.exam_questions,
          window: examWindowState(t.exams, now),
        },
        attempt: mine.length
          ? {
              id: (inProgress ?? mine[0]).id,
              status: (inProgress ?? mine[0]).status,
            }
          : null,
        can_start:
          t.status === 'OPEN' &&
          t.exams.status === 'PUBLISHED' &&
          examWindowState(t.exams, now) === 'OPEN' &&
          !mine.length,
        result: published
          ? {
              percentage: award?.percentage ?? null,
              rank: award?.rank ?? null,
              candidates: candidates.get(t.batch_id) ?? 0,
              discount_percent: award?.discount_percent ?? 0,
              used: !!award?.used_invoice_id,
              expired: !!t.valid_until && t.valid_until < startOfToday(),
            }
          : null,
      };
    });
  }

  // ---------------------------------------------------------------- admin: results and awards

  /** Every candidate with their best graded attempt, rank and the slab it earns (or the override). */
  async results(id: bigint) {
    const t = await this.get(id);
    const slabs = t.slabs as Slab[];
    const [candidates, attempts, awards] = await Promise.all([
      this.prisma.enrollments.findMany({
        where: { batch_id: t.batch_id, status: { not: 'CANCELLED' } },
        select: {
          student_user_id: true,
          enrolled_at: true,
          student_profiles: {
            select: {
              grade: true,
              school_name: true,
              users: {
                select: {
                  id: true,
                  full_name: true,
                  mobile: true,
                  email: true,
                  photo_url: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.exam_attempts.findMany({
        where: { exam_id: t.exam_id, status: { in: [...GRADED] } },
        select: {
          id: true,
          score: true,
          max_score: true,
          percentage: true,
          submitted_at: true,
          enrollments: { select: { student_user_id: true } },
        },
      }),
      this.prisma.scholarship_awards.findMany({
        where: { scholarship_test_id: id },
      }),
    ]);

    const best = new Map<bigint, (typeof attempts)[number]>();
    for (const a of attempts) {
      const key = a.enrollments.student_user_id;
      const cur = best.get(key);
      if (!cur || Number(a.percentage ?? -1) > Number(cur.percentage ?? -1))
        best.set(key, a);
    }
    const ranked = [...best.entries()].sort(
      ([, a], [, b]) =>
        Number(b.percentage ?? 0) - Number(a.percentage ?? 0) ||
        (a.submitted_at?.getTime() ?? 0) - (b.submitted_at?.getTime() ?? 0),
    );
    const rankOf = new Map(ranked.map(([student], i) => [student, i + 1]));

    const rows = candidates.map((c) => {
      const attempt = best.get(c.student_user_id) ?? null;
      const percentage =
        attempt?.percentage !== undefined && attempt?.percentage !== null
          ? Number(attempt.percentage)
          : null;
      const suggested = discountFor(percentage, slabs);
      const award = awards.find((a) => a.student_user_id === c.student_user_id);
      return {
        student: c.student_profiles.users,
        grade: c.student_profiles.grade,
        school_name: c.student_profiles.school_name,
        registered_at: c.enrolled_at,
        attempt: attempt
          ? {
              id: attempt.id,
              score: attempt.score,
              max_score: attempt.max_score,
              percentage: attempt.percentage,
              submitted_at: attempt.submitted_at,
            }
          : null,
        rank: rankOf.get(c.student_user_id) ?? null,
        suggested_discount: suggested,
        discount_percent: award?.is_override
          ? Number(award.discount_percent)
          : suggested,
        is_override: !!award?.is_override,
        note: award?.note ?? null,
        used: !!award?.used_invoice_id,
      };
    });
    rows.sort(
      (a, b) =>
        (a.rank ?? 1e9) - (b.rank ?? 1e9) ||
        a.student.full_name.localeCompare(b.student.full_name),
    );
    return {
      test: await this.findOne(id),
      took_test: best.size,
      candidates: rows,
    };
  }

  /** Sets a candidate's award by hand (before or after publishing); null discount clears the override. */
  async override(id: bigint, studentUserId: bigint, dto: OverrideAwardDto) {
    const t = await this.get(id);
    const candidate = await this.prisma.enrollments.findFirst({
      where: { batch_id: t.batch_id, student_user_id: studentUserId },
      select: { id: true },
    });
    if (!candidate)
      throw new NotFoundException(
        'This student is not registered for the test',
      );
    const existing = await this.prisma.scholarship_awards.findUnique({
      where: {
        scholarship_test_id_student_user_id: {
          scholarship_test_id: id,
          student_user_id: studentUserId,
        },
      },
    });
    if (existing?.used_invoice_id)
      throw new ConflictException(
        'This scholarship has already been applied to a fee invoice',
      );
    const clear = dto.discountPercent === null;
    await this.prisma.scholarship_awards.upsert({
      where: {
        scholarship_test_id_student_user_id: {
          scholarship_test_id: id,
          student_user_id: studentUserId,
        },
      },
      create: {
        scholarship_test_id: id,
        student_user_id: studentUserId,
        discount_percent: clear ? 0 : dto.discountPercent!,
        is_override: !clear,
        note: dto.note,
      },
      update: {
        // Clearing goes back to the slab (recomputed on publish or in the results list).
        discount_percent: clear
          ? existing?.discount_percent
          : dto.discountPercent!,
        is_override: !clear,
        note: dto.note,
      },
    });
    // After publishing, the stored award must reflect the slab again when an override is cleared.
    if (clear && t.status === 'RESULTS_PUBLISHED') await this.storeAwards(id);
    return this.results(id);
  }

  /** Stores every ranked candidate's award, releases the results and notifies the candidates. */
  async publish(id: bigint) {
    const t = await this.get(id);
    if (t.status === 'DRAFT')
      throw new BadRequestException('Open the test before publishing results');
    if (t.status === 'RESULTS_PUBLISHED')
      throw new ConflictException('Results are already published');
    const now = new Date();
    const rows = await this.storeAwards(id);
    await this.prisma.$transaction([
      this.prisma.exams.update({
        where: { id: t.exam_id },
        data: { results_release_at: now },
      }),
      this.prisma.scholarship_tests.update({
        where: { id },
        data: { status: 'RESULTS_PUBLISHED', results_published_at: now },
      }),
    ]);
    for (const r of rows.filter((r) => r.attempt)) {
      await this.notifications.notify([r.student.id], {
        title:
          r.discount_percent > 0
            ? `Scholarship awarded: ${r.discount_percent}% off`
            : `${t.title}: results are out`,
        message:
          r.discount_percent > 0
            ? `You ranked ${r.rank} in ${t.title} and won ${r.discount_percent}% off your course fees${t.valid_until ? `, valid until ${t.valid_until.toISOString().slice(0, 10)}` : ''}.`
            : `You ranked ${r.rank} in ${t.title}. See your score in the student portal.`,
        linkUrl: `/student/scholarships?test=${id}`,
        email: true,
      });
    }
    return this.results(id);
  }

  /** Awards a student can still use (published, > 0%, unused, not expired): for the invoice dialog. */
  async availableAwards(studentUserId: bigint) {
    const awards = await this.prisma.scholarship_awards.findMany({
      where: {
        student_user_id: studentUserId,
        used_invoice_id: null,
        discount_percent: { gt: 0 },
        scholarship_tests: {
          status: 'RESULTS_PUBLISHED',
          OR: [{ valid_until: null }, { valid_until: { gte: startOfToday() } }],
        },
      },
      select: {
        id: true,
        discount_percent: true,
        rank: true,
        percentage: true,
        scholarship_tests: {
          select: { id: true, title: true, valid_until: true },
        },
      },
      orderBy: { discount_percent: 'desc' },
    });
    return awards;
  }

  // ---------------------------------------------------------------- helpers

  private async storeAwards(id: bigint) {
    const { candidates } = await this.results(id);
    for (const r of candidates.filter((r) => r.attempt)) {
      await this.prisma.scholarship_awards.upsert({
        where: {
          scholarship_test_id_student_user_id: {
            scholarship_test_id: id,
            student_user_id: r.student.id,
          },
        },
        create: {
          scholarship_test_id: id,
          student_user_id: r.student.id,
          percentage: r.attempt!.percentage,
          rank: r.rank,
          discount_percent: r.discount_percent,
        },
        update: {
          percentage: r.attempt!.percentage,
          rank: r.rank,
          ...(r.is_override || r.used
            ? {}
            : { discount_percent: r.discount_percent }),
        },
      });
    }
    return candidates;
  }

  private async get(id: bigint) {
    const t = await this.prisma.scholarship_tests.findUnique({
      where: { id },
      include: testInclude,
    });
    if (!t) throw new NotFoundException('Scholarship test not found');
    return t;
  }

  private present(
    t: Prisma.scholarship_testsGetPayload<{ include: typeof testInclude }>,
    candidates: number,
  ) {
    return {
      ...t,
      eligible_grades: grades(t.eligible_grades),
      slabs: t.slabs as Slab[],
      candidates,
    };
  }

  private async candidateCounts(batchIds: bigint[]) {
    if (!batchIds.length) return new Map<bigint, number>();
    const rows = await this.prisma.enrollments.groupBy({
      by: ['batch_id'],
      where: { batch_id: { in: batchIds }, status: { not: 'CANCELLED' } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.batch_id, r._count._all]));
  }

  /** The hidden "Scholarship Tests" course, created on first use with every subject attached. */
  private async ensureCourse(): Promise<bigint> {
    const course = await this.prisma.courses.upsert({
      where: { code: COURSE.code },
      update: {},
      create: { ...COURSE, status: 'DRAFT' },
      select: { id: true },
    });
    const [subjects, linked] = await Promise.all([
      this.prisma.subjects.findMany({ select: { id: true } }),
      this.prisma.course_subjects.findMany({
        where: { course_id: course.id },
        select: { subject_id: true },
      }),
    ]);
    const have = new Set(linked.map((l) => l.subject_id));
    const missing = subjects.filter((s) => !have.has(s.id));
    if (missing.length)
      await this.prisma.course_subjects.createMany({
        data: missing.map((s) => ({ course_id: course.id, subject_id: s.id })),
        skipDuplicates: true,
      });
    return course.id;
  }
}

function startOfToday() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Hides the candidates batches from student-facing course lists (they hold only the test). */
export const notScholarshipBatch: Prisma.batchesWhereInput = {
  scholarship_tests: { is: null },
};
