import {
  ForbiddenException,
  Global,
  Injectable,
  Module,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, isAdmin, hasRole, RoleCode } from './auth.js';

/**
 * An enrollment that currently grants access: status ACTIVE and, when the admin set an access
 * window, `access_starts_at <= now < access_ends_at`. Use this wherever "enrolled" is checked.
 */
export function currentEnrollmentWhere(
  now: Date = new Date(),
): Prisma.enrollmentsWhereInput {
  return {
    status: 'ACTIVE',
    AND: [
      { OR: [{ access_starts_at: null }, { access_starts_at: { lte: now } }] },
      { OR: [{ access_ends_at: null }, { access_ends_at: { gt: now } }] },
    ],
  };
}

/**
 * Batch-scoped permission checks shared by every module that hangs off a batch
 * (classes, attendance, assignments, exams, announcements, fees...).
 *
 * - Admins manage everything.
 * - Faculty manage a batch when batch_faculty assigns them to it (any subject).
 * - Students view a batch when they hold an ACTIVE enrollment in it.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertBatchExists(batchId: bigint) {
    const batch = await this.prisma.batches.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('Batch not found');
    return batch;
  }

  async isBatchFaculty(
    userId: bigint,
    batchId: bigint,
    subjectId?: bigint,
  ): Promise<boolean> {
    const row = await this.prisma.batch_faculty.findFirst({
      where: {
        batch_id: batchId,
        faculty_user_id: userId,
        ...(subjectId ? { subject_id: subjectId } : {}),
      },
      select: { batch_id: true },
    });
    return !!row;
  }

  /** Admin, or faculty assigned to the batch. */
  async canManageBatch(user: AuthUser, batchId: bigint): Promise<boolean> {
    if (isAdmin(user)) return true;
    return (
      hasRole(user, RoleCode.FACULTY) && this.isBatchFaculty(user.id, batchId)
    );
  }

  async assertCanManageBatch(user: AuthUser, batchId: bigint): Promise<void> {
    await this.assertBatchExists(batchId);
    if (!(await this.canManageBatch(user, batchId))) {
      throw new ForbiddenException(
        'Only admins and faculty assigned to this batch can do this',
      );
    }
  }

  /** The student's current enrollment in the batch (ACTIVE and within its access window), or null. */
  activeEnrollment(studentUserId: bigint, batchId: bigint) {
    return this.prisma.enrollments.findFirst({
      where: {
        student_user_id: studentUserId,
        batch_id: batchId,
        ...currentEnrollmentWhere(),
      },
    });
  }

  /**
   * Allows managers of the batch and its actively enrolled students.
   * Returns the student's enrollment (null for admins and faculty).
   */
  async assertCanViewBatch(user: AuthUser, batchId: bigint) {
    await this.assertBatchExists(batchId);
    if (await this.canManageBatch(user, batchId)) return null;
    if (hasRole(user, RoleCode.STUDENT)) {
      const enrollment = await this.activeEnrollment(user.id, batchId);
      if (enrollment) return enrollment;
    }
    throw new ForbiddenException('You are not part of this batch');
  }

  /** Batch ids the user may view: all for admins, assigned for faculty, actively enrolled for students. */
  async visibleBatchIds(user: AuthUser): Promise<bigint[] | 'all'> {
    if (isAdmin(user)) return 'all';
    const ids = new Set<bigint>();
    if (hasRole(user, RoleCode.FACULTY)) {
      for (const row of await this.prisma.batch_faculty.findMany({
        where: { faculty_user_id: user.id },
        select: { batch_id: true },
      })) {
        ids.add(row.batch_id);
      }
    }
    if (hasRole(user, RoleCode.STUDENT)) {
      for (const row of await this.prisma.enrollments.findMany({
        where: { student_user_id: user.id, ...currentEnrollmentWhere() },
        select: { batch_id: true },
      })) {
        ids.add(row.batch_id);
      }
    }
    return [...ids];
  }
}

@Global()
@Module({ providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
