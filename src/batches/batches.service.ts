import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, isStaff, RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import {
  AssignFacultyDto,
  CreateBatchDto,
  ListBatchesQueryDto,
  UpdateBatchDto,
} from './dto/batch.dto.js';

/** Statuses that hold a seat. */
export const SEAT_STATUSES = ['PENDING', 'ACTIVE'] as const;

const batchInclude = {
  courses: { select: { id: true, code: true, slug: true, title: true } },
  batch_faculty: {
    select: {
      subjects: { select: { id: true, code: true, name: true } },
      faculty_profiles: {
        select: { user_id: true, users: { select: { full_name: true } } },
      },
    },
  },
  _count: {
    select: { enrollments: { where: { status: { in: [...SEAT_STATUSES] } } } },
  },
} satisfies Prisma.batchesInclude;

type BatchRow = Prisma.batchesGetPayload<{ include: typeof batchInclude }>;

function present({ _count, batch_faculty, ...batch }: BatchRow) {
  const enrolled = _count.enrollments;
  return {
    ...batch,
    faculty: batch_faculty.map((bf) => ({
      userId: bf.faculty_profiles.user_id,
      fullName: bf.faculty_profiles.users.full_name,
      subject: bf.subjects,
    })),
    enrolled,
    seatsAvailable:
      batch.capacity === null ? null : Math.max(batch.capacity - enrolled, 0),
  };
}

@Injectable()
export class BatchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /**
   * Visitors see PLANNED/ACTIVE batches of published courses (for admissions).
   * Staff see everything; `mine=true` narrows to the user's own batches.
   */
  async findAll(query: ListBatchesQueryDto, user?: AuthUser) {
    let idFilter: Prisma.batchesWhereInput = {};
    if (query.mine && user) {
      const ids = await this.access.visibleBatchIds(user);
      if (ids !== 'all') idFilter = { id: { in: ids } };
    }
    const visibility: Prisma.batchesWhereInput =
      isStaff(user) || query.mine
        ? {}
        : {
            status: { in: ['PLANNED', 'ACTIVE'] },
            courses: { status: 'PUBLISHED' },
          };
    const where: Prisma.batchesWhereInput = {
      ...visibility,
      ...idFilter,
      course_id:
        query.courseId === undefined ? undefined : BigInt(query.courseId),
      ...(query.status ? { status: query.status } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.batches.findMany({
        where,
        include: batchInclude,
        orderBy: [{ start_date: 'asc' }, { id: 'asc' }],
        ...skipTake(query),
      }),
      this.prisma.batches.count({ where }),
    ]);
    return paginated(rows.map(present), total, query);
  }

  /** Public for open batches of published courses; otherwise staff or an enrolled student. */
  async findOne(id: bigint, user?: AuthUser) {
    const batch = await this.prisma.batches.findUnique({
      where: { id },
      include: {
        ...batchInclude,
        courses: { select: { ...batchInclude.courses.select, status: true } },
      },
    });
    const publicOk =
      batch &&
      ['PLANNED', 'ACTIVE'].includes(batch.status) &&
      batch.courses.status === 'PUBLISHED';
    if (
      !batch ||
      (!publicOk &&
        !isStaff(user) &&
        !(user && (await this.access.activeEnrollment(user.id, id))))
    ) {
      throw new NotFoundException('Batch not found');
    }
    return present(batch);
  }

  private async load(id: bigint) {
    return present(
      await this.prisma.batches.findUniqueOrThrow({
        where: { id },
        include: batchInclude,
      }),
    );
  }

  async create(dto: CreateBatchDto) {
    await this.assertCourse(dto.courseId);
    assertDates(dto.startDate, dto.endDate);
    const batch = await this.prisma.batches.create({
      data: {
        course_id: BigInt(dto.courseId),
        code: dto.code,
        name: dto.name,
        start_date: dto.startDate,
        end_date: dto.endDate,
        capacity: dto.capacity,
        status: dto.status,
      },
      include: batchInclude,
    });
    return present(batch);
  }

  async update(id: bigint, dto: UpdateBatchDto) {
    const existing = await this.access.assertBatchExists(id);
    if (
      dto.courseId !== undefined &&
      BigInt(dto.courseId) !== existing.course_id
    ) {
      const used = await this.prisma.batch_faculty.count({
        where: { batch_id: id },
      });
      if (used)
        throw new BadRequestException(
          'Remove the faculty assignments before moving the batch to another course',
        );
      await this.assertCourse(dto.courseId);
    }
    assertDates(
      dto.startDate === undefined ? existing.start_date : dto.startDate,
      dto.endDate === undefined ? existing.end_date : dto.endDate,
    );
    if (dto.capacity !== undefined && dto.capacity !== null) {
      const seats = await this.prisma.enrollments.count({
        where: { batch_id: id, status: { in: [...SEAT_STATUSES] } },
      });
      if (dto.capacity < seats)
        throw new BadRequestException(
          `capacity cannot be below the ${seats} students already enrolled`,
        );
    }
    const batch = await this.prisma.batches.update({
      where: { id },
      data: {
        course_id:
          dto.courseId === undefined ? undefined : BigInt(dto.courseId),
        code: dto.code,
        name: dto.name,
        start_date: dto.startDate,
        end_date: dto.endDate,
        capacity: dto.capacity,
        status: dto.status,
      },
      include: batchInclude,
    });
    return present(batch);
  }

  /** Only a batch with no enrollments or content can be deleted; otherwise mark it CANCELLED. */
  async remove(id: bigint): Promise<void> {
    await this.access.assertBatchExists(id);
    await this.prisma.$transaction([
      this.prisma.batch_faculty.deleteMany({ where: { batch_id: id } }),
      this.prisma.batches.delete({ where: { id } }),
    ]);
  }

  async assignFaculty(batchId: bigint, dto: AssignFacultyDto) {
    const batch = await this.access.assertBatchExists(batchId);
    const facultyUserId = BigInt(dto.facultyUserId);
    const subjectId = BigInt(dto.subjectId);
    const faculty = await this.prisma.faculty_profiles.findUnique({
      where: { user_id: facultyUserId },
      select: {
        users: {
          select: {
            status: true,
            deleted_at: true,
            user_roles: { select: { roles: { select: { code: true } } } },
          },
        },
      },
    });
    const isFaculty = faculty?.users.user_roles.some(
      (ur) => ur.roles.code === RoleCode.FACULTY,
    );
    if (
      !faculty ||
      !isFaculty ||
      faculty.users.deleted_at ||
      faculty.users.status === 'DISABLED'
    ) {
      throw new BadRequestException(
        'facultyUserId must belong to an active faculty member',
      );
    }
    const cs = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: batch.course_id,
          subject_id: subjectId,
        },
      },
    });
    if (!cs)
      throw new BadRequestException(
        "subjectId is not one of this batch's course subjects",
      );
    const existing = await this.prisma.batch_faculty.findUnique({
      where: {
        batch_id_faculty_user_id_subject_id: {
          batch_id: batchId,
          faculty_user_id: facultyUserId,
          subject_id: subjectId,
        },
      },
    });
    if (existing)
      throw new ConflictException(
        'This faculty member already teaches this subject in the batch',
      );
    await this.prisma.batch_faculty.create({
      data: {
        batch_id: batchId,
        faculty_user_id: facultyUserId,
        subject_id: subjectId,
      },
    });
    return this.load(batchId);
  }

  async unassignFaculty(
    batchId: bigint,
    facultyUserId: bigint,
    subjectId: bigint,
  ): Promise<void> {
    await this.prisma.batch_faculty.delete({
      where: {
        batch_id_faculty_user_id_subject_id: {
          batch_id: batchId,
          faculty_user_id: facultyUserId,
          subject_id: subjectId,
        },
      },
    });
  }

  /** Enrolled students. Admins and the batch's faculty only. */
  async roster(batchId: bigint, user: AuthUser) {
    await this.access.assertCanManageBatch(user, batchId);
    return this.prisma.enrollments.findMany({
      where: { batch_id: batchId },
      orderBy: [
        { status: 'asc' },
        { student_profiles: { users: { full_name: 'asc' } } },
      ],
      select: {
        id: true,
        status: true,
        enrolled_at: true,
        access_starts_at: true,
        access_ends_at: true,
        student_profiles: {
          select: {
            user_id: true,
            admission_number: true,
            grade: true,
            guardian_name: true,
            guardian_mobile: true,
            users: { select: { full_name: true, email: true, mobile: true } },
          },
        },
      },
    });
  }

  private async assertCourse(courseId: number): Promise<void> {
    const course = await this.prisma.courses.findUnique({
      where: { id: BigInt(courseId) },
      select: { status: true },
    });
    if (!course)
      throw new BadRequestException('courseId does not match any course');
    if (course.status === 'ARCHIVED')
      throw new BadRequestException('Cannot use an archived course');
  }
}

/** Mirrors chk_batch_dates. */
function assertDates(start?: Date | null, end?: Date | null): void {
  if (start && end && end < start)
    throw new BadRequestException('endDate must be on or after startDate');
}
