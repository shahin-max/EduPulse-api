import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AccessService,
  currentEnrollmentWhere,
} from '../common/access.service.js';
import { AuthUser, hasRole, RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { summarize } from './attendance-summary.js';
import {
  CreateClassSessionDto,
  ListClassSessionsQueryDto,
  MarkAttendanceDto,
  TimetableQueryDto,
  UpdateClassSessionDto,
} from './dto/classes.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const sessionInclude = {
  batches: { select: { id: true, code: true, name: true } },
  subjects: { select: { id: true, code: true, name: true } },
  faculty_profiles: {
    select: { user_id: true, users: { select: { full_name: true } } },
  },
} satisfies Prisma.class_sessionsInclude;

@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async create(dto: CreateClassSessionDto, user: AuthUser) {
    const batchId = BigInt(dto.batchId);
    await this.access.assertCanManageBatch(user, batchId);
    assertTimes(dto.startsAt, dto.endsAt);
    const subjectId =
      dto.subjectId === undefined ? null : BigInt(dto.subjectId);
    await this.assertSubjectInBatch(batchId, subjectId);

    let facultyId: bigint | null =
      dto.facultyUserId === undefined ? null : BigInt(dto.facultyUserId);
    if (
      facultyId === null &&
      hasRole(user, RoleCode.FACULTY) &&
      (await this.access.isBatchFaculty(user.id, batchId))
    ) {
      facultyId = user.id;
    }
    await this.assertTeachesBatch(batchId, facultyId);

    return this.prisma.class_sessions.create({
      data: {
        batch_id: batchId,
        subject_id: subjectId,
        faculty_user_id: facultyId,
        title: dto.title,
        starts_at: dto.startsAt,
        ends_at: dto.endsAt,
        meeting_url: dto.meetingUrl,
        recording_url: dto.recordingUrl,
      },
      include: sessionInclude,
    });
  }

  async list(query: ListClassSessionsQueryDto, user: AuthUser) {
    const batchId = BigInt(query.batchId);
    await this.access.assertCanViewBatch(user, batchId);
    const where: Prisma.class_sessionsWhereInput = {
      batch_id: batchId,
      status: query.status,
      starts_at:
        query.from || query.to ? { gte: query.from, lt: query.to } : undefined,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.class_sessions.findMany({
        where,
        include: sessionInclude,
        orderBy: { starts_at: 'asc' },
        ...skipTake(query),
      }),
      this.prisma.class_sessions.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** Sessions across every batch the user teaches or attends (admins: all batches). */
  async timetable(query: TimetableQueryDto, user: AuthUser) {
    const from = query.from ?? new Date();
    const to = query.to ?? new Date(from.getTime() + 7 * DAY_MS);
    if (to <= from) throw new BadRequestException('to must be after from');
    if (to.getTime() - from.getTime() > 31 * DAY_MS)
      throw new BadRequestException(
        'The timetable range can be at most 31 days',
      );
    const ids = await this.access.visibleBatchIds(user);
    return this.prisma.class_sessions.findMany({
      where: {
        starts_at: { gte: from, lt: to },
        ...(ids === 'all' ? {} : { batch_id: { in: ids } }),
      },
      include: sessionInclude,
      orderBy: { starts_at: 'asc' },
    });
  }

  async findOne(id: bigint, user: AuthUser) {
    const session = await this.getSession(id);
    await this.access.assertCanViewBatch(user, session.batch_id);
    return this.prisma.class_sessions.findUniqueOrThrow({
      where: { id },
      include: sessionInclude,
    });
  }

  async update(id: bigint, dto: UpdateClassSessionDto, user: AuthUser) {
    const session = await this.getSession(id);
    await this.access.assertCanManageBatch(user, session.batch_id);
    assertTimes(
      dto.startsAt ?? session.starts_at,
      dto.endsAt ?? session.ends_at,
    );
    if (dto.subjectId !== undefined)
      await this.assertSubjectInBatch(
        session.batch_id,
        dto.subjectId === null ? null : BigInt(dto.subjectId),
      );
    if (dto.facultyUserId !== undefined) {
      await this.assertTeachesBatch(
        session.batch_id,
        dto.facultyUserId === null ? null : BigInt(dto.facultyUserId),
      );
    }
    return this.prisma.class_sessions.update({
      where: { id },
      data: {
        subject_id:
          dto.subjectId === undefined
            ? undefined
            : dto.subjectId === null
              ? null
              : BigInt(dto.subjectId),
        faculty_user_id:
          dto.facultyUserId === undefined
            ? undefined
            : dto.facultyUserId === null
              ? null
              : BigInt(dto.facultyUserId),
        title: dto.title,
        starts_at: dto.startsAt,
        ends_at: dto.endsAt,
        meeting_url: dto.meetingUrl,
        recording_url: dto.recordingUrl,
        status: dto.status,
      },
      include: sessionInclude,
    });
  }

  async cancel(id: bigint, user: AuthUser) {
    return this.update(id, { status: 'CANCELLED' }, user);
  }

  /** Upserts attendance for the listed enrollments of the session's batch. */
  async markAttendance(id: bigint, dto: MarkAttendanceDto, user: AuthUser) {
    const session = await this.getSession(id);
    await this.access.assertCanManageBatch(user, session.batch_id);
    if (session.status === 'CANCELLED')
      throw new BadRequestException(
        'Attendance cannot be marked for a cancelled class',
      );
    if (session.starts_at > new Date())
      throw new BadRequestException(
        'Attendance cannot be marked before the class starts',
      );

    const ids = dto.entries.map((e) => BigInt(e.enrollmentId));
    if (new Set(ids.map(String)).size !== ids.length)
      throw new BadRequestException('Each enrollment may appear only once');
    const valid = await this.prisma.enrollments.findMany({
      where: { id: { in: ids }, batch_id: session.batch_id },
      select: { id: true },
    });
    if (valid.length !== ids.length) {
      const known = new Set(valid.map((v) => String(v.id)));
      const bad = ids.filter((i) => !known.has(String(i)));
      throw new BadRequestException(
        `Enrollments not in this batch: ${bad.join(', ')}`,
      );
    }

    const markedAt = new Date();
    await this.prisma.$transaction(
      dto.entries.map((entry) =>
        this.prisma.class_attendance.upsert({
          where: {
            class_session_id_enrollment_id: {
              class_session_id: id,
              enrollment_id: BigInt(entry.enrollmentId),
            },
          },
          update: {
            status: entry.status,
            marked_by: user.id,
            marked_at: markedAt,
          },
          create: {
            class_session_id: id,
            batch_id: session.batch_id,
            enrollment_id: BigInt(entry.enrollmentId),
            status: entry.status,
            marked_by: user.id,
            marked_at: markedAt,
          },
        }),
      ),
    );
    return this.attendanceSheet(id, user);
  }

  /** Every currently active (or already marked) enrollment of the batch with its mark, or null. */
  async attendanceSheet(id: bigint, user: AuthUser) {
    const session = await this.getSession(id);
    await this.access.assertCanManageBatch(user, session.batch_id);
    const [enrollments, marks] = await Promise.all([
      this.prisma.enrollments.findMany({
        where: {
          batch_id: session.batch_id,
          OR: [
            currentEnrollmentWhere(session.starts_at),
            { class_attendance: { some: { class_session_id: id } } },
          ],
        },
        select: {
          id: true,
          status: true,
          student_profiles: {
            select: {
              user_id: true,
              admission_number: true,
              users: { select: { full_name: true } },
            },
          },
        },
        orderBy: { student_profiles: { users: { full_name: 'asc' } } },
      }),
      this.prisma.class_attendance.findMany({
        where: { class_session_id: id },
      }),
    ]);
    const byEnrollment = new Map(
      marks.map((m) => [String(m.enrollment_id), m]),
    );
    const rows = enrollments.map((e) => {
      const mark = byEnrollment.get(String(e.id));
      return {
        enrollment_id: e.id,
        enrollment_status: e.status,
        student_user_id: e.student_profiles.user_id,
        full_name: e.student_profiles.users.full_name,
        admission_number: e.student_profiles.admission_number,
        status: mark?.status ?? null,
        marked_at: mark?.marked_at ?? null,
        marked_by: mark?.marked_by ?? null,
      };
    });
    return {
      session: {
        id: session.id,
        batch_id: session.batch_id,
        title: session.title,
        starts_at: session.starts_at,
        status: session.status,
      },
      summary: summarize(marks.map((m) => m.status)),
      students: rows,
    };
  }

  /** The student's own attendance, grouped by batch with a summary each. */
  async myAttendance(user: AuthUser) {
    const records = await this.prisma.class_attendance.findMany({
      where: { enrollments: { student_user_id: user.id } },
      include: {
        class_sessions: {
          select: {
            id: true,
            title: true,
            starts_at: true,
            subjects: { select: { id: true, name: true } },
          },
        },
        enrollments: {
          select: { batches: { select: { id: true, code: true, name: true } } },
        },
      },
      orderBy: { class_sessions: { starts_at: 'desc' } },
    });
    const groups = new Map<
      string,
      {
        batch: { id: bigint; code: string; name: string };
        records: typeof records;
      }
    >();
    for (const record of records) {
      const batch = record.enrollments.batches;
      const key = String(batch.id);
      if (!groups.has(key)) groups.set(key, { batch, records: [] });
      groups.get(key)!.records.push(record);
    }
    return [...groups.values()].map(({ batch, records: rs }) => ({
      batch,
      summary: summarize(rs.map((r) => r.status)),
      records: rs.map((r) => ({
        session: r.class_sessions,
        status: r.status,
        marked_at: r.marked_at,
      })),
    }));
  }

  private async getSession(id: bigint) {
    const session = await this.prisma.class_sessions.findUnique({
      where: { id },
    });
    if (!session) throw new NotFoundException('Class session not found');
    return session;
  }

  private async assertSubjectInBatch(
    batchId: bigint,
    subjectId: bigint | null,
  ): Promise<void> {
    if (subjectId === null) return;
    const batch = await this.prisma.batches.findUniqueOrThrow({
      where: { id: batchId },
      select: { course_id: true },
    });
    const link = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: batch.course_id,
          subject_id: subjectId,
        },
      },
    });
    if (!link)
      throw new BadRequestException(
        "subjectId is not one of this batch's course subjects",
      );
  }

  private async assertTeachesBatch(
    batchId: bigint,
    facultyId: bigint | null,
  ): Promise<void> {
    if (facultyId === null) return;
    if (!(await this.access.isBatchFaculty(facultyId, batchId))) {
      throw new BadRequestException(
        'facultyUserId must be a faculty member assigned to this batch',
      );
    }
  }
}

/** Mirrors chk_class_time. */
function assertTimes(start: Date, end: Date): void {
  if (end <= start)
    throw new BadRequestException('endsAt must be after startsAt');
}
