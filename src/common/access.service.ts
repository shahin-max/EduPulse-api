import {
  ForbiddenException,
  Global,
  Injectable,
  Module,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AuthUser,
  isAdmin,
  isBranchAdmin,
  hasRole,
  RoleCode,
} from './auth.js';

/** Branches an admin works with: every branch (super admin) or a list. */
export type BranchScope = bigint[] | 'all';

/** Prisma filter for a `branch_id` column: undefined (no filter) for 'all'. */
export function branchIn(scope: BranchScope): { in: bigint[] } | undefined {
  return scope === 'all' ? undefined : { in: scope };
}

/** A real admission: Scholarship Test candidate batches do not tie a student to a branch. */
const admission: Prisma.enrollmentsWhereInput = {
  batches: { scholarship_tests: { is: null } },
};

/**
 * Students a branch admin may see: those enrolled (in any state) at one of their branches, and
 * those not admitted anywhere yet (new sign-ups, walk-ins and Scholarship Test candidates).
 */
export function branchStudentsWhere(
  branchIds: bigint[],
): Prisma.usersWhereInput {
  return {
    user_roles: { some: { roles: { code: RoleCode.STUDENT } } },
    OR: [
      {
        student_profiles: {
          enrollments: {
            some: { ...admission, branch_id: { in: branchIds } },
          },
        },
      },
      { student_profiles: { enrollments: { none: admission } } },
    ],
  };
}

/** Faculty a branch admin may see: those branch_staff lists as FACULTY at one of their branches. */
export function branchFacultyWhere(
  branchIds: bigint[],
): Prisma.usersWhereInput {
  return {
    user_roles: { some: { roles: { code: RoleCode.FACULTY } } },
    branch_staff: {
      some: {
        branch_id: { in: branchIds },
        roles: { code: RoleCode.FACULTY },
      },
    },
  };
}

/** No admin of any kind: branch admins never see or change admin accounts. */
const notAnAdmin: Prisma.usersWhereInput = {
  user_roles: { none: { roles: { code: RoleCode.ADMIN } } },
  branch_staff: { none: { roles: { code: RoleCode.ADMIN } } },
};

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
 * - The super admin manages everything; a branch admin manages the batches of their branches.
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

  /** Branches the user administers: 'all' for the super admin, none for everyone else. */
  adminBranches(user: AuthUser): BranchScope {
    if (isAdmin(user)) return 'all';
    return isBranchAdmin(user) ? [...user.adminBranchIds!] : [];
  }

  isAdminOfBranch(user: AuthUser, branchId: bigint | null): boolean {
    if (isAdmin(user)) return true;
    return (
      branchId !== null &&
      isBranchAdmin(user) &&
      user.adminBranchIds!.includes(branchId)
    );
  }

  /**
   * Branch filter for an admin list. `requested` narrows it (the portal's branch switcher): the
   * super admin may ask for any branch, a branch admin only for one of theirs (403 otherwise).
   */
  branchScope(user: AuthUser, requested?: number | bigint | null): BranchScope {
    const mine = this.adminBranches(user);
    if (requested === undefined || requested === null) return mine;
    const id = BigInt(requested);
    if (mine !== 'all' && !mine.includes(id))
      throw new ForbiddenException('You can only work with your own branches');
    return [id];
  }

  /**
   * The user may manage a record of this branch. `null` (shared by every branch, e.g. a fee plan
   * for all branches or an enquiry nobody routed yet) is the super admin's.
   */
  assertBranchAdmin(user: AuthUser, branchId: bigint | null): void {
    if (this.isAdminOfBranch(user, branchId)) return;
    throw new ForbiddenException(
      branchId === null
        ? 'Only the head office can manage records shared by every branch'
        : 'This belongs to another branch',
    );
  }

  /**
   * Users a branch admin may see and manage (students and faculty of their branches, and students
   * not enrolled anywhere yet). Undefined: no limit (super admin).
   */
  manageableUsersWhere(user: AuthUser): Prisma.usersWhereInput | undefined {
    const scope = this.adminBranches(user);
    if (scope === 'all') return undefined;
    return {
      AND: [
        notAnAdmin,
        { OR: [branchStudentsWhere(scope), branchFacultyWhere(scope)] },
      ],
    };
  }

  /** 404 unless the user is visible to this admin (see manageableUsersWhere). */
  async assertCanManageUser(user: AuthUser, userId: bigint): Promise<void> {
    const where = this.manageableUsersWhere(user);
    if (!where) return;
    const found = await this.prisma.users.findFirst({
      where: { AND: [{ id: userId }, where] },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('User not found');
  }

  /** Admin of the batch's branch, or faculty assigned to the batch. */
  async canManageBatch(user: AuthUser, batchId: bigint): Promise<boolean> {
    if (isAdmin(user)) return true;
    if (isBranchAdmin(user)) {
      const batch = await this.prisma.batches.findUnique({
        where: { id: batchId },
        select: { branch_id: true },
      });
      if (batch && this.isAdminOfBranch(user, batch.branch_id)) return true;
    }
    return (
      hasRole(user, RoleCode.FACULTY) && this.isBatchFaculty(user.id, batchId)
    );
  }

  async assertCanManageBatch(user: AuthUser, batchId: bigint): Promise<void> {
    await this.assertBatchExists(batchId);
    if (!(await this.canManageBatch(user, batchId))) {
      throw new ForbiddenException(
        "Only this batch's branch admins and assigned faculty can do this",
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
   * The student's most recent enrollment in the batch that ever gave access (ACTIVE, PAUSED or
   * COMPLETED), ignoring the access window. Used to let students re-read their own past work,
   * read-only, after a batch ends; anything that changes data still needs `activeEnrollment`.
   */
  pastEnrollment(studentUserId: bigint, batchId: bigint) {
    return this.prisma.enrollments.findFirst({
      where: {
        student_user_id: studentUserId,
        batch_id: batchId,
        status: { in: ['ACTIVE', 'PAUSED', 'COMPLETED'] },
      },
      orderBy: { enrolled_at: 'desc' },
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

  /**
   * Batch ids the user may view: all for the super admin, their branches' batches for a branch
   * admin, assigned for faculty, actively enrolled for students.
   */
  async visibleBatchIds(user: AuthUser): Promise<bigint[] | 'all'> {
    if (isAdmin(user)) return 'all';
    const ids = new Set<bigint>();
    if (isBranchAdmin(user)) {
      for (const row of await this.prisma.batches.findMany({
        where: { branch_id: { in: user.adminBranchIds! } },
        select: { id: true },
      })) {
        ids.add(row.id);
      }
    }
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
