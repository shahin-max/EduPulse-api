import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { enrollments_status } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { SEAT_STATUSES } from './batches.service.js';
import {
  CreateEnrollmentDto,
  ListEnrollmentsQueryDto,
  UpdateEnrollmentDto,
} from './dto/batch.dto.js';

const enrollmentInclude = {
  student_profiles: {
    select: {
      user_id: true,
      admission_number: true,
      users: { select: { full_name: true, email: true, mobile: true } },
    },
  },
  batches: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      start_date: true,
      end_date: true,
      courses: { select: { id: true, code: true, slug: true, title: true } },
    },
  },
} satisfies Prisma.enrollmentsInclude;

type Tx = Prisma.TransactionClient;
const holdsSeat = (status: enrollments_status) =>
  (SEAT_STATUSES as readonly string[]).includes(status);

@Injectable()
export class EnrollmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Enrols a student. Re-opens a previous CANCELLED/COMPLETED enrollment in the same batch. */
  async create(dto: CreateEnrollmentDto, actorId: bigint) {
    const studentId = BigInt(dto.studentUserId);
    const batchId = BigInt(dto.batchId);
    assertAccessWindow(dto.accessStartsAt, dto.accessEndsAt);
    return this.prisma.$transaction(async (tx) => {
      const student = await tx.users.findUnique({
        where: { id: studentId },
        select: {
          status: true,
          deleted_at: true,
          user_roles: { select: { roles: { select: { code: true } } } },
          student_profiles: { select: { user_id: true } },
        },
      });
      const isStudent =
        student?.user_roles.some((ur) => ur.roles.code === RoleCode.STUDENT) &&
        student.student_profiles;
      if (
        !student ||
        !isStudent ||
        student.deleted_at ||
        student.status === 'SUSPENDED' ||
        student.status === 'DISABLED'
      ) {
        throw new BadRequestException(
          'studentUserId must belong to an active student',
        );
      }
      await lockBatchWithSeat(tx, batchId);

      const existing = await tx.enrollments.findUnique({
        where: {
          student_user_id_batch_id: {
            student_user_id: studentId,
            batch_id: batchId,
          },
        },
      });
      if (existing && holdsSeat(existing.status))
        throw new ConflictException(
          'Student is already enrolled in this batch',
        );
      const data = {
        status: dto.status ?? 'ACTIVE',
        access_starts_at: dto.accessStartsAt,
        access_ends_at: dto.accessEndsAt,
        completed_at: null,
        created_by: actorId,
      } as const;
      return existing
        ? tx.enrollments.update({
            where: { id: existing.id },
            data: { ...data, enrolled_at: new Date() },
            include: enrollmentInclude,
          })
        : tx.enrollments.create({
            data: { ...data, student_user_id: studentId, batch_id: batchId },
            include: enrollmentInclude,
          });
    });
  }

  async findAll(query: ListEnrollmentsQueryDto) {
    const where: Prisma.enrollmentsWhereInput = {
      batch_id: query.batchId === undefined ? undefined : BigInt(query.batchId),
      student_user_id:
        query.studentUserId === undefined
          ? undefined
          : BigInt(query.studentUserId),
      status: query.status,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.enrollments.findMany({
        where,
        include: enrollmentInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.enrollments.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** The student's own enrollments with batch and course. */
  findForStudent(studentId: bigint) {
    return this.prisma.enrollments.findMany({
      where: { student_user_id: studentId },
      include: { batches: enrollmentInclude.batches },
      orderBy: { enrolled_at: 'desc' },
    });
  }

  update(id: bigint, dto: UpdateEnrollmentDto) {
    return this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollments.findUnique({ where: { id } });
      if (!enrollment) throw new NotFoundException('Enrollment not found');
      assertAccessWindow(
        dto.accessStartsAt === undefined
          ? enrollment.access_starts_at
          : dto.accessStartsAt,
        dto.accessEndsAt === undefined
          ? enrollment.access_ends_at
          : dto.accessEndsAt,
      );
      if (
        dto.status &&
        holdsSeat(dto.status) &&
        !holdsSeat(enrollment.status)
      ) {
        await lockBatchWithSeat(tx, enrollment.batch_id);
      }
      return tx.enrollments.update({
        where: { id },
        data: {
          status: dto.status,
          access_starts_at: dto.accessStartsAt,
          access_ends_at: dto.accessEndsAt,
          ...(dto.status === 'COMPLETED'
            ? { completed_at: new Date() }
            : dto.status
              ? { completed_at: null }
              : {}),
        },
        include: enrollmentInclude,
      });
    });
  }
}

/**
 * Locks the batch row (SELECT ... FOR UPDATE) so concurrent enrollments are serialised,
 * then checks the batch accepts students and has a free seat (PENDING + ACTIVE < capacity).
 */
export async function lockBatchWithSeat(
  tx: Tx,
  batchId: bigint,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: bigint }[]
  >`SELECT id FROM batches WHERE id = ${batchId} FOR UPDATE`;
  if (rows.length === 0)
    throw new BadRequestException('batchId does not match any batch');
  const batch = await tx.batches.findUniqueOrThrow({
    where: { id: batchId },
    select: { capacity: true, status: true },
  });
  if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
    throw new BadRequestException('This batch is not accepting enrollments');
  }
  if (batch.capacity !== null) {
    const taken = await tx.enrollments.count({
      where: { batch_id: batchId, status: { in: [...SEAT_STATUSES] } },
    });
    if (taken >= batch.capacity)
      throw new ConflictException('This batch is full');
  }
}

/** Mirrors chk_enrollment_access. */
function assertAccessWindow(start?: Date | null, end?: Date | null): void {
  if (start && end && end <= start)
    throw new BadRequestException('accessEndsAt must be after accessStartsAt');
}
