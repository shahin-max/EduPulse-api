import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { setupApp } from '../src/setup-app.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import type { RoleCode } from '../src/common/auth.js';

export interface TestContext {
  app: INestApplication<App>;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
}

export const api = (path: string) => `/api/v1${path}`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Boots the real application (same pipeline as main.ts) and empties the test database. */
export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = setupApp(
    moduleRef.createNestApplication(),
  ) as INestApplication<App>;
  await app.init();
  const prisma = app.get(PrismaService);
  await wipe(prisma);
  return { app, prisma, http: () => request(app.getHttpServer()) };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  await wipe(ctx.prisma);
  await ctx.app.close();
}

/** Deletes every row except the reference `roles`. Only ever runs against a *_test database. */
export async function wipe(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('roles', '_prisma_migrations')`;
  const [{ db }] = await prisma.$queryRaw<
    { db: string }[]
  >`SELECT DATABASE() AS db`;
  if (!db.endsWith('_test')) throw new Error(`Refusing to wipe ${db}`);
  // One pinned connection, so FOREIGN_KEY_CHECKS=0 applies to the deletes.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of tables)
      await tx.$executeRawUnsafe(`DELETE FROM \`${name}\``);
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  });
}

let counter = 0;

/**
 * Creates an ACTIVE user directly in the database with the given roles (and the matching
 * profile rows), logs in through the API and returns the user id and access token.
 */
export async function createUser(
  ctx: TestContext,
  roles: RoleCode[],
  overrides: { email?: string; fullName?: string; password?: string } = {},
): Promise<{
  id: number;
  token: string;
  refreshToken: string;
  email: string;
  password: string;
}> {
  counter += 1;
  const email =
    overrides.email ??
    `${roles.join('-').toLowerCase()}${counter}-${Date.now()}@test.local`;
  const password = overrides.password ?? 'Passw0rd!';
  const passwordHash = await ctx.app.get(PasswordService).hash(password);
  const user = await ctx.prisma.users.create({
    data: {
      public_id: randomUUID(),
      full_name: overrides.fullName ?? `Test ${roles.join('/')} ${counter}`,
      email,
      status: 'ACTIVE',
      password_hash: passwordHash,
      user_roles: {
        create: roles.map((code) => ({ roles: { connect: { code } } })),
      },
      ...(roles.includes('STUDENT')
        ? { student_profiles: { create: {} } }
        : {}),
      ...(roles.includes('FACULTY')
        ? { faculty_profiles: { create: {} } }
        : {}),
    },
  });
  const res = await ctx
    .http()
    .post(api('/auth/login'))
    .send({ login: email, password })
    .expect(200);
  return {
    id: Number(user.id),
    token: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    email,
    password,
  };
}

/**
 * Builds a course with one subject and a batch, and assigns `facultyId` (if given) to teach
 * that subject. Returns the ids. Handy starting point for batch-scoped e2e tests.
 */
/** The branch test batches belong to. wipe() deletes branches too, so it is recreated on demand. */
export async function testBranchId(ctx: TestContext): Promise<number> {
  const branch = await ctx.prisma.branches.upsert({
    where: { code: 'TEST' },
    create: { code: 'TEST', name: 'Test Branch', invoice_prefix: 'TST', receipt_prefix: 'TST' },
    update: {},
  });
  return Number(branch.id);
}

export async function createCourseWithBatch(
  ctx: TestContext,
  opts: {
    facultyId?: number;
    capacity?: number | null;
    status?: 'PLANNED' | 'ACTIVE';
  } = {},
) {
  counter += 1;
  const course = await ctx.prisma.courses.create({
    data: {
      code: `C${counter}X${Date.now() % 100000}`,
      slug: `course-${counter}-${Date.now()}`,
      title: `Course ${counter}`,
      status: 'PUBLISHED',
    },
  });
  const subject = await ctx.prisma.subjects.create({
    data: {
      code: `S${counter}X${Date.now() % 100000}`,
      name: `Subject ${counter}`,
    },
  });
  const courseSubject = await ctx.prisma.course_subjects.create({
    data: { course_id: course.id, subject_id: subject.id },
  });
  const batch = await ctx.prisma.batches.create({
    data: {
      branch_id: BigInt(await testBranchId(ctx)),
      course_id: course.id,
      code: `B${counter}X${Date.now() % 100000}`,
      name: `Batch ${counter}`,
      capacity: opts.capacity === undefined ? 30 : opts.capacity,
      status: opts.status ?? 'ACTIVE',
    },
  });
  if (opts.facultyId) {
    await ctx.prisma.batch_faculty.create({
      data: {
        batch_id: batch.id,
        faculty_user_id: BigInt(opts.facultyId),
        subject_id: subject.id,
      },
    });
  }
  return {
    courseId: Number(course.id),
    subjectId: Number(subject.id),
    courseSubjectId: Number(courseSubject.id),
    batchId: Number(batch.id),
  };
}

/** Enrols a student directly (ACTIVE) and returns the enrollment id. */
export async function enrol(
  ctx: TestContext,
  studentId: number,
  batchId: number,
): Promise<number> {
  const batch = await ctx.prisma.batches.findUniqueOrThrow({
    where: { id: BigInt(batchId) },
    select: { branch_id: true },
  });
  const enrollment = await ctx.prisma.enrollments.create({
    data: {
      student_user_id: BigInt(studentId),
      batch_id: BigInt(batchId),
      branch_id: batch.branch_id,
      status: 'ACTIVE',
    },
  });
  return Number(enrollment.id);
}
