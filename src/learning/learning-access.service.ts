import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, hasRole, isStaff, RoleCode } from '../common/auth.js';
import { currentEnrollmentWhere } from '../common/access.service.js';

/** Minimal shape of a file_assets row needed for access decisions. */
export interface FileAccessInfo {
  id: bigint;
  visibility: 'PUBLIC' | 'PRIVATE';
  uploaded_by: bigint | null;
}

/**
 * Course-scoped access rules for learning content.
 *
 * - Admins and faculty see all study content (faculty author materials for every course).
 * - Students see published content of a course while they hold a current (ACTIVE, in-window) enrollment in
 *   any batch of that course.
 */
@Injectable()
export class LearningAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** The student's most recent current (ACTIVE, within its access window) enrollment in any batch of the course, or null. */
  studentEnrollmentInCourse(userId: bigint, courseId: bigint) {
    return this.prisma.enrollments.findFirst({
      where: {
        student_user_id: userId,
        ...currentEnrollmentWhere(),
        batches: { course_id: courseId },
      },
      orderBy: { enrolled_at: 'desc' },
    });
  }

  /** Loads a chapter with the id of its course; 404 when missing. */
  async chapterWithCourse(chapterId: bigint) {
    const chapter = await this.prisma.chapters.findUnique({
      where: { id: chapterId },
      include: { course_subjects: { select: { course_id: true } } },
    });
    if (!chapter) throw new NotFoundException('Chapter not found');
    return { ...chapter, course_id: chapter.course_subjects.course_id };
  }

  /**
   * Whether the user may read a file.
   * PUBLIC: everyone. PRIVATE: admins, faculty, the uploader, or a student who reaches it
   * through a published material of an enrolled course, an assignment of their batch,
   * or their own submission.
   */
  async canReadFile(
    user: AuthUser | undefined,
    file: FileAccessInfo,
  ): Promise<boolean> {
    if (file.visibility === 'PUBLIC') return true;
    if (!user) return false;
    if (isStaff(user)) return true;
    if (file.uploaded_by !== null && file.uploaded_by === user.id) return true;
    if (!hasRole(user, RoleCode.STUDENT)) return false;

    const activeInCourse = {
      batches: {
        some: {
          enrollments: {
            some: { student_user_id: user.id, ...currentEnrollmentWhere() },
          },
        },
      },
    };
    const viaMaterial = await this.prisma.study_materials.findFirst({
      where: {
        asset_id: file.id,
        is_published: true,
        chapters: {
          is_published: true,
          course_subjects: { courses: activeInCourse },
        },
      },
      select: { id: true },
    });
    if (viaMaterial) return true;

    const viaAssignment = await this.prisma.assignments.findFirst({
      where: {
        attachment_asset_id: file.id,
        status: { in: ['PUBLISHED', 'CLOSED'] },
        batches: {
          enrollments: {
            some: { student_user_id: user.id, ...currentEnrollmentWhere() },
          },
        },
      },
      select: { id: true },
    });
    if (viaAssignment) return true;

    const viaOwnSubmission = await this.prisma.assignment_submissions.findFirst(
      {
        where: { asset_id: file.id, enrollments: { student_user_id: user.id } },
        select: { id: true },
      },
    );
    return !!viaOwnSubmission;
  }
}
