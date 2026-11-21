import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService, BranchScope, branchIn } from '../common/access.service.js';
import { AuthUser, isAdmin, isBranchAdmin, RoleCode } from '../common/auth.js';
import {
  AddBranchStaffDto,
  BranchStaffRole,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto.js';

const withCounts = {
  _count: { select: { batches: true, branch_staff: true } },
} as const;

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** Branch admins see only their own branches; head office and faculty see all of them. */
  list(includeInactive: boolean, user: AuthUser) {
    return this.prisma.branches.findMany({
      where: {
        ...(includeInactive ? {} : { is_active: true }),
        id: branchIn(visibleBranches(user)),
      },
      include: withCounts,
      orderBy: { name: 'asc' },
    });
  }

  /** Active branches as the website shows them (no prefixes, GSTIN or counts). */
  publicList() {
    return this.prisma.branches.findMany({
      where: { is_active: true },
      select: {
        id: true,
        code: true,
        name: true,
        address: true,
        city: true,
        phone: true,
        email: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: bigint, user?: AuthUser) {
    const branch = await this.prisma.branches.findUnique({
      where: { id },
      include: withCounts,
    });
    const scope = user ? visibleBranches(user) : 'all';
    if (!branch || (scope !== 'all' && !scope.includes(id)))
      throw new NotFoundException('Branch not found');
    return branch;
  }

  /** A duplicate code becomes a 409 through PrismaExceptionFilter (P2002). */
  async create(dto: CreateBranchDto) {
    await this.assertPrefixesFree(dto);
    return this.prisma.branches.create({
      data: {
        ...toRow(dto),
        code: dto.code,
        name: dto.name,
        invoice_prefix: dto.invoicePrefix,
        receipt_prefix: dto.receiptPrefix,
      },
      include: withCounts,
    });
  }

  async update(id: bigint, dto: UpdateBranchDto) {
    await this.findOne(id);
    await this.assertPrefixesFree(dto, id);
    return this.prisma.branches.update({
      where: { id },
      data: toRow(dto),
      include: withCounts,
    });
  }

  // ---- Staff ----

  /** Admins and faculty of the branch. Head office (global ADMIN role) is not listed here. */
  async listStaff(branchId: bigint, user: AuthUser) {
    await this.findOne(branchId, user);
    this.access.assertBranchAdmin(user, branchId);
    const rows = await this.prisma.branch_staff.findMany({
      where: { branch_id: branchId },
      orderBy: [{ role_id: 'asc' }, { users: { full_name: 'asc' } }],
      select: {
        assigned_at: true,
        roles: { select: { code: true } },
        users: {
          select: {
            id: true,
            full_name: true,
            email: true,
            mobile: true,
            status: true,
            photo_url: true,
            deleted_at: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      role: r.roles.code,
      assigned_at: r.assigned_at,
      user: r.users,
    }));
  }

  /**
   * Adds a branch admin (head office only) or a faculty member to the branch. A branch admin can
   * add faculty to their own branch. Adding the same person twice is a 409.
   */
  async addStaff(branchId: bigint, dto: AddBranchStaffDto, user: AuthUser) {
    const branch = await this.findOne(branchId, user);
    this.access.assertBranchAdmin(user, branchId);
    if (dto.role === 'ADMIN' && !isAdmin(user))
      throw new ForbiddenException('Only head office can add branch admins');
    if (!branch.is_active)
      throw new BadRequestException('This branch is closed');
    const userId = BigInt(dto.userId);
    const target = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        status: true,
        deleted_at: true,
        user_roles: { select: { roles: { select: { code: true } } } },
      },
    });
    if (!target || target.deleted_at || target.status === 'DISABLED')
      throw new BadRequestException('userId must belong to an active user');
    const codes = target.user_roles.map((ur) => ur.roles.code);
    if (dto.role === 'FACULTY' && !codes.includes(RoleCode.FACULTY))
      throw new BadRequestException(
        'Give the user the FACULTY role before adding them to a branch as faculty',
      );
    if (dto.role === 'ADMIN') {
      if (codes.includes(RoleCode.ADMIN))
        throw new BadRequestException(
          'This user is head office (global ADMIN) and already runs every branch',
        );
      if (codes.includes(RoleCode.STUDENT))
        throw new BadRequestException('A student cannot be a branch admin');
    }
    await addBranchStaff(this.prisma, userId, branchId, dto.role, true);
    return this.listStaff(branchId, user);
  }

  async removeStaff(
    branchId: bigint,
    userId: bigint,
    role: BranchStaffRole,
    user: AuthUser,
  ): Promise<void> {
    await this.findOne(branchId, user);
    this.access.assertBranchAdmin(user, branchId);
    if (role === 'ADMIN' && !isAdmin(user))
      throw new ForbiddenException('Only head office can remove branch admins');
    const { count } = await this.prisma.branch_staff.deleteMany({
      where: {
        user_id: userId,
        branch_id: branchId,
        roles: { code: role },
      },
    });
    if (!count) throw new NotFoundException('Not on this branch staff');
  }

  // ---- Courses offered ----

  /** Courses the branch offers; a branch admin can only open batches for active ones. */
  async listCourses(branchId: bigint, user: AuthUser) {
    await this.findOne(branchId, user);
    const rows = await this.prisma.branch_courses.findMany({
      where: { branch_id: branchId },
      orderBy: { courses: { title: 'asc' } },
      select: {
        is_active: true,
        created_at: true,
        courses: {
          select: {
            id: true,
            code: true,
            slug: true,
            title: true,
            status: true,
          },
        },
      },
    });
    return rows.map((r) => ({
      is_active: r.is_active,
      added_at: r.created_at,
      course: r.courses,
    }));
  }

  /** Head office: offer a course at the branch (or offer it again). */
  async offerCourse(branchId: bigint, courseId: bigint, user: AuthUser) {
    await this.findOne(branchId);
    const course = await this.prisma.courses.findUnique({
      where: { id: courseId },
      select: { status: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.status === 'ARCHIVED')
      throw new BadRequestException('Cannot offer an archived course');
    await this.prisma.branch_courses.upsert({
      where: {
        branch_id_course_id: { branch_id: branchId, course_id: courseId },
      },
      create: { branch_id: branchId, course_id: courseId },
      update: { is_active: true },
    });
    return this.listCourses(branchId, user);
  }

  /** Head office: stop offering a course. Running batches carry on; no new ones can be opened. */
  async withdrawCourse(branchId: bigint, courseId: bigint): Promise<void> {
    const { count } = await this.prisma.branch_courses.updateMany({
      where: { branch_id: branchId, course_id: courseId },
      data: { is_active: false },
    });
    if (!count)
      throw new NotFoundException('This branch does not offer that course');
  }

  /**
   * Invoice and receipt numbers are "<prefix>/<year>/<n>" with a sequence per branch, so two branches
   * sharing a prefix would produce the same numbers.
   */
  private async assertPrefixesFree(dto: UpdateBranchDto, exceptId?: bigint) {
    const checks = [
      { field: 'invoice_prefix', value: dto.invoicePrefix, label: 'invoice' },
      { field: 'receipt_prefix', value: dto.receiptPrefix, label: 'receipt' },
    ] as const;
    for (const { field, value, label } of checks) {
      if (value === undefined) continue;
      const other = await this.prisma.branches.findFirst({
        where: {
          [field]: value,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { name: true },
      });
      if (other)
        throw new ConflictException(
          `The ${label} prefix ${value} is already used by ${other.name}; each branch needs its own`,
        );
    }
  }
}

/** Branch admins see their own branches; everyone else (head office, faculty) sees all. */
function visibleBranches(user: AuthUser): BranchScope {
  return isBranchAdmin(user) ? [...user.adminBranchIds!] : 'all';
}

type StaffClient = Pick<Prisma.TransactionClient, 'branch_staff' | 'roles'>;

/**
 * Puts the user on the branch staff with the role. With `conflict`, an existing row is a 409;
 * otherwise it is left as it is.
 */
export async function addBranchStaff(
  prisma: StaffClient,
  userId: bigint,
  branchId: bigint,
  role: BranchStaffRole,
  conflict = false,
): Promise<void> {
  const { id: roleId } = await prisma.roles.findUniqueOrThrow({
    where: { code: role },
    select: { id: true },
  });
  const key = { user_id: userId, branch_id: branchId, role_id: roleId };
  const existing = await prisma.branch_staff.findUnique({
    where: { user_id_branch_id_role_id: key },
  });
  if (existing) {
    if (conflict)
      throw new ConflictException(
        `This user is already ${role === 'ADMIN' ? 'an admin' : 'faculty'} at this branch`,
      );
    return;
  }
  await prisma.branch_staff.create({ data: key });
}

function toRow(dto: UpdateBranchDto) {
  return {
    code: dto.code,
    name: dto.name,
    invoice_prefix: dto.invoicePrefix,
    receipt_prefix: dto.receiptPrefix,
    address: dto.address,
    city: dto.city,
    state: dto.state,
    pincode: dto.pincode,
    phone: dto.phone,
    email: dto.email,
    gstin: dto.gstin,
    is_active: dto.isActive,
  };
}
