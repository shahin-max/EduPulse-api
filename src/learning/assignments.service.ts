import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, hasRole, RoleCode } from '../common/auth.js';
import {
  CreateAssignmentDto,
  ReviewSubmissionDto,
  SubmitAssignmentDto,
  UpdateAssignmentDto,
} from './dto/learning.dto.js';

/** A submission is late when it arrived after the due time. Late work is accepted until the assignment is CLOSED. */
export function isLate(submittedAt: Date, dueAt: Date | null): boolean {
  return !!dueAt && submittedAt > dueAt;
}

/** Mirrors chk_submission_score and the assignment's max_marks. */
export function assertMarks(
  marks: number | undefined,
  maxMarks: Prisma.Decimal | null,
): void {
  if (marks === undefined) return;
  if (marks < 0)
    throw new BadRequestException('marksAwarded cannot be negative');
  if (maxMarks !== null && new Prisma.Decimal(marks).greaterThan(maxMarks)) {
    throw new BadRequestException(
      `marksAwarded cannot exceed maxMarks (${maxMarks.toString()})`,
    );
  }
}

const assignmentInclude = {
  subjects: { select: { id: true, code: true, name: true } },
  file_assets: {
    select: { id: true, original_filename: true, mime_type: true },
  },
  users: { select: { id: true, full_name: true } },
} satisfies Prisma.assignmentsInclude;

const submissionInclude = {
  file_assets: {
    select: { id: true, original_filename: true, mime_type: true },
  },
  enrollments: {
    select: {
      id: true,
      student_user_id: true,
      student_profiles: {
        select: {
          admission_number: true,
          users: { select: { full_name: true } },
        },
      },
    },
  },
  users: { select: { id: true, full_name: true } },
} satisfies Prisma.assignment_submissionsInclude;

type SubmissionRow = Prisma.assignment_submissionsGetPayload<{
  include: typeof submissionInclude;
}>;

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async create(dto: CreateAssignmentDto, user: AuthUser) {
    const batchId = BigInt(dto.batchId);
    await this.access.assertCanManageBatch(user, batchId);
    await this.assertSubjectInBatch(batchId, dto.subjectId);
    await this.assertAsset(dto.attachmentAssetId);
    return this.prisma.assignments.create({
      data: {
        batch_id: batchId,
        subject_id:
          dto.subjectId === undefined ? undefined : BigInt(dto.subjectId),
        title: dto.title,
        instructions: dto.instructions,
        attachment_asset_id:
          dto.attachmentAssetId === undefined
            ? undefined
            : BigInt(dto.attachmentAssetId),
        due_at: dto.dueAt,
        max_marks: dto.maxMarks,
        status: dto.status,
        created_by: user.id,
      },
      include: assignmentInclude,
    });
  }

  /**
   * Assignments of a batch. Managers see all statuses with submission counts; enrolled
   * students see PUBLISHED and CLOSED ones, each with their own submission (if any).
   */
  async list(batchIdNum: number, user: AuthUser) {
    const batchId = BigInt(batchIdNum);
    const enrollment = await this.access.assertCanViewBatch(user, batchId);
    if (!enrollment) {
      return this.prisma.assignments.findMany({
        where: { batch_id: batchId },
        include: {
          ...assignmentInclude,
          _count: { select: { assignment_submissions: true } },
        },
        orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
      });
    }
    const rows = await this.prisma.assignments.findMany({
      where: { batch_id: batchId, status: { in: ['PUBLISHED', 'CLOSED'] } },
      include: {
        ...assignmentInclude,
        assignment_submissions: { where: { enrollment_id: enrollment.id } },
      },
      orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
    });
    return rows.map(({ assignment_submissions, ...assignment }) => ({
      ...assignment,
      my_submission: assignment_submissions[0]
        ? {
            ...assignment_submissions[0],
            is_late: isLate(
              assignment_submissions[0].submitted_at,
              assignment.due_at,
            ),
          }
        : null,
    }));
  }

  async findOne(id: bigint, user: AuthUser) {
    const assignment = await this.getAssignment(id);
    const enrollment = await this.access.assertCanViewBatch(
      user,
      assignment.batch_id,
    );
    if (enrollment && assignment.status === 'DRAFT')
      throw new NotFoundException('Assignment not found');
    return assignment;
  }

  async update(id: bigint, dto: UpdateAssignmentDto, user: AuthUser) {
    const assignment = await this.getAssignment(id);
    await this.access.assertCanManageBatch(user, assignment.batch_id);
    if (dto.subjectId !== undefined && dto.subjectId !== null)
      await this.assertSubjectInBatch(assignment.batch_id, dto.subjectId);
    await this.assertAsset(dto.attachmentAssetId);
    if (dto.maxMarks !== undefined && dto.maxMarks !== null) {
      const over = await this.prisma.assignment_submissions.count({
        where: { assignment_id: id, marks_awarded: { gt: dto.maxMarks } },
      });
      if (over)
        throw new BadRequestException(
          `maxMarks is below the marks already awarded to ${over} submission(s)`,
        );
    }
    return this.prisma.assignments.update({
      where: { id },
      data: {
        subject_id:
          dto.subjectId === undefined
            ? undefined
            : dto.subjectId === null
              ? null
              : BigInt(dto.subjectId),
        title: dto.title,
        instructions: dto.instructions,
        attachment_asset_id:
          dto.attachmentAssetId === undefined
            ? undefined
            : dto.attachmentAssetId === null
              ? null
              : BigInt(dto.attachmentAssetId),
        due_at: dto.dueAt,
        max_marks: dto.maxMarks,
        status: dto.status,
      },
      include: assignmentInclude,
    });
  }

  /** 409 (via the Prisma filter) once students have submitted; close it instead. */
  async remove(id: bigint, user: AuthUser): Promise<void> {
    const assignment = await this.getAssignment(id);
    await this.access.assertCanManageBatch(user, assignment.batch_id);
    await this.prisma.assignments.delete({ where: { id } });
  }

  /**
   * Submit or resubmit. Only PUBLISHED assignments accept work; late submissions are
   * accepted and flagged. Resubmitting is allowed until the submission has been reviewed.
   */
  async submit(id: bigint, dto: SubmitAssignmentDto, user: AuthUser) {
    if (!dto.responseText && dto.assetId === undefined) {
      throw new BadRequestException(
        'A submission needs responseText or assetId',
      );
    }
    const assignment = await this.getAssignment(id);
    if (!hasRole(user, RoleCode.STUDENT))
      throw new ForbiddenException('Only students submit assignments');
    const enrollment = await this.access.activeEnrollment(
      user.id,
      assignment.batch_id,
    );
    if (!enrollment)
      throw new ForbiddenException('You are not part of this batch');
    if (assignment.status === 'DRAFT')
      throw new NotFoundException('Assignment not found');
    if (assignment.status === 'CLOSED')
      throw new BadRequestException(
        'This assignment is closed for submissions',
      );

    if (dto.assetId !== undefined) {
      const asset = await this.prisma.file_assets.findUnique({
        where: { id: BigInt(dto.assetId) },
        select: { uploaded_by: true },
      });
      // Attaching someone else's file would grant access to it, so only your own uploads count.
      if (!asset || asset.uploaded_by !== user.id)
        throw new BadRequestException('assetId must be a file you uploaded');
    }

    const key = {
      assignment_id_enrollment_id: {
        assignment_id: id,
        enrollment_id: enrollment.id,
      },
    };
    const existing = await this.prisma.assignment_submissions.findUnique({
      where: key,
    });
    if (existing?.reviewed_at)
      throw new ConflictException('This submission has already been reviewed');
    const content = {
      response_text: dto.responseText ?? null,
      asset_id: dto.assetId === undefined ? null : BigInt(dto.assetId),
      submitted_at: new Date(),
    };
    const saved = existing
      ? await this.prisma.assignment_submissions.update({
          where: key,
          data: content,
          include: submissionInclude,
        })
      : await this.prisma.assignment_submissions.create({
          data: {
            ...content,
            assignment_id: id,
            enrollment_id: enrollment.id,
            batch_id: assignment.batch_id,
          },
          include: submissionInclude,
        });
    return present(saved, assignment.due_at);
  }

  /** The logged-in student's submission for the assignment. */
  async mySubmission(id: bigint, user: AuthUser) {
    const assignment = await this.getAssignment(id);
    const enrollment = await this.access.activeEnrollment(
      user.id,
      assignment.batch_id,
    );
    const submission = enrollment
      ? await this.prisma.assignment_submissions.findUnique({
          where: {
            assignment_id_enrollment_id: {
              assignment_id: id,
              enrollment_id: enrollment.id,
            },
          },
          include: submissionInclude,
        })
      : null;
    if (!submission)
      throw new NotFoundException('You have not submitted this assignment');
    return present(submission, assignment.due_at);
  }

  async listSubmissions(id: bigint, user: AuthUser) {
    const assignment = await this.getAssignment(id);
    await this.access.assertCanManageBatch(user, assignment.batch_id);
    const rows = await this.prisma.assignment_submissions.findMany({
      where: { assignment_id: id },
      include: submissionInclude,
      orderBy: { submitted_at: 'asc' },
    });
    return rows.map((row) => present(row, assignment.due_at));
  }

  async review(submissionId: bigint, dto: ReviewSubmissionDto, user: AuthUser) {
    const submission = await this.prisma.assignment_submissions.findUnique({
      where: { id: submissionId },
      include: { assignments: { select: { max_marks: true, due_at: true } } },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    await this.access.assertCanManageBatch(user, submission.batch_id);
    if (dto.marksAwarded === undefined && dto.feedback === undefined) {
      throw new BadRequestException('Provide marksAwarded and/or feedback');
    }
    assertMarks(dto.marksAwarded, submission.assignments.max_marks);
    const saved = await this.prisma.assignment_submissions.update({
      where: { id: submissionId },
      data: {
        marks_awarded: dto.marksAwarded,
        feedback: dto.feedback,
        reviewed_by: user.id,
        reviewed_at: new Date(),
      },
      include: submissionInclude,
    });
    return present(saved, submission.assignments.due_at);
  }

  private async getAssignment(id: bigint) {
    const assignment = await this.prisma.assignments.findUnique({
      where: { id },
      include: assignmentInclude,
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    return assignment;
  }

  private async assertSubjectInBatch(
    batchId: bigint,
    subjectId?: number,
  ): Promise<void> {
    if (subjectId === undefined) return;
    const batch = await this.prisma.batches.findUniqueOrThrow({
      where: { id: batchId },
      select: { course_id: true },
    });
    const cs = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: batch.course_id,
          subject_id: BigInt(subjectId),
        },
      },
    });
    if (!cs)
      throw new BadRequestException(
        "subjectId is not one of this batch's course subjects",
      );
  }

  private async assertAsset(assetId?: number | null): Promise<void> {
    if (assetId === undefined || assetId === null) return;
    const asset = await this.prisma.file_assets.findUnique({
      where: { id: BigInt(assetId) },
      select: { id: true },
    });
    if (!asset)
      throw new BadRequestException(
        'attachmentAssetId does not match any file',
      );
  }
}

function present(row: SubmissionRow, dueAt: Date | null) {
  return { ...row, is_late: isLate(row.submitted_at, dueAt) };
}
