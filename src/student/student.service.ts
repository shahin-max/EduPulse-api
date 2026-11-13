import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser } from '../common/auth.js';
import { currentEnrollmentWhere } from '../common/access.service.js';
import { isLate } from '../learning/assignments.service.js';
import { submissionState } from '../reports/reports.service.js';

const publishedChapters = (courseId: bigint) => ({
  is_published: true,
  course_subjects: { course_id: courseId },
});

/**
 * Read-only views for the student portal that would otherwise take one request per batch or
 * chapter. Everything is limited to the student's current enrollments (ACTIVE, inside the
 * access window), the same rule the per-batch endpoints use.
 */
@Injectable()
export class StudentService {
  constructor(private readonly prisma: PrismaService) {}

  private currentEnrollments(userId: bigint) {
    return this.prisma.enrollments.findMany({
      where: { student_user_id: userId, ...currentEnrollmentWhere() },
      orderBy: { enrolled_at: 'desc' },
      select: {
        id: true,
        batch_id: true,
        enrolled_at: true,
        access_ends_at: true,
        batches: {
          select: {
            id: true,
            code: true,
            name: true,
            status: true,
            start_date: true,
            end_date: true,
            course_id: true,
            courses: {
              select: { id: true, code: true, slug: true, title: true },
            },
            branches: { select: { id: true, code: true, name: true } },
          },
        },
      },
    });
  }

  /** Current batches with their teachers and the student's study-material progress per course. */
  async courses(user: AuthUser) {
    const enrollments = await this.currentEnrollments(user.id);
    return Promise.all(
      enrollments.map(async (e) => {
        const courseId = e.batches.course_id;
        const materialWhere = {
          is_published: true,
          chapters: publishedChapters(courseId),
        };
        const [faculty, total, completed] = await Promise.all([
          this.prisma.batch_faculty.findMany({
            where: { batch_id: e.batch_id },
            select: {
              subjects: { select: { id: true, name: true } },
              faculty_profiles: {
                select: {
                  user_id: true,
                  users: { select: { full_name: true, photo_url: true } },
                },
              },
            },
          }),
          this.prisma.study_materials.count({ where: materialWhere }),
          this.prisma.material_progress.count({
            where: {
              enrollment_id: e.id,
              status: 'COMPLETED',
              study_materials: materialWhere,
            },
          }),
        ]);
        return {
          enrollment_id: e.id,
          enrolled_at: e.enrolled_at,
          access_ends_at: e.access_ends_at,
          batch: e.batches,
          teachers: faculty.map((f) => ({
            user_id: f.faculty_profiles.user_id,
            full_name: f.faculty_profiles.users.full_name,
            photo_url: f.faculty_profiles.users.photo_url,
            subject: f.subjects,
          })),
          materials: { total, completed },
        };
      }),
    );
  }

  /** Every published or closed assignment in the student's current batches, with their submission. */
  async assignments(user: AuthUser) {
    const enrollments = await this.currentEnrollments(user.id);
    if (!enrollments.length) return [];
    const rows = await this.prisma.assignments.findMany({
      where: {
        batch_id: { in: enrollments.map((e) => e.batch_id) },
        status: { in: ['PUBLISHED', 'CLOSED'] },
      },
      orderBy: [{ due_at: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        batch_id: true,
        title: true,
        due_at: true,
        max_marks: true,
        status: true,
        created_at: true,
        subjects: { select: { id: true, name: true } },
        batches: { select: { id: true, code: true, name: true } },
        assignment_submissions: {
          where: { enrollment_id: { in: enrollments.map((e) => e.id) } },
          select: {
            id: true,
            submitted_at: true,
            marks_awarded: true,
            reviewed_at: true,
            asset_id: true,
          },
        },
      },
    });
    const now = new Date();
    return rows.map(({ assignment_submissions, ...a }) => {
      const sub = assignment_submissions[0];
      return {
        ...a,
        state: submissionState(sub, a.due_at, now),
        my_submission: sub
          ? { ...sub, is_late: isLate(sub.submitted_at, a.due_at) }
          : null,
      };
    });
  }

  /**
   * A course's published chapters (by subject) with their published materials and the student's
   * progress on each. 403 without a current enrollment in the course.
   */
  async courseMaterials(user: AuthUser, courseId: bigint) {
    const enrollment = await this.prisma.enrollments.findFirst({
      where: {
        student_user_id: user.id,
        ...currentEnrollmentWhere(),
        batches: { course_id: courseId },
      },
      orderBy: { enrolled_at: 'desc' },
      select: { id: true },
    });
    if (!enrollment)
      throw new ForbiddenException('You are not enrolled in this course');

    const [course, subjects, progress] = await Promise.all([
      this.prisma.courses.findUniqueOrThrow({
        where: { id: courseId },
        select: { id: true, code: true, slug: true, title: true },
      }),
      this.prisma.course_subjects.findMany({
        where: { course_id: courseId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          subjects: { select: { id: true, code: true, name: true } },
          chapters: {
            where: { is_published: true },
            orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              title: true,
              description: true,
              study_materials: {
                where: { is_published: true },
                orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
                select: {
                  id: true,
                  title: true,
                  kind: true,
                  asset_id: true,
                  external_url: true,
                  is_downloadable: true,
                  file_assets: {
                    select: {
                      id: true,
                      original_filename: true,
                      mime_type: true,
                      size_bytes: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
      this.prisma.material_progress.findMany({
        where: { enrollment_id: enrollment.id },
        select: {
          material_id: true,
          status: true,
          last_accessed_at: true,
          completed_at: true,
        },
      }),
    ]);

    const byMaterial = new Map(progress.map((p) => [p.material_id, p]));
    return {
      course,
      subjects: subjects
        .filter((s) => s.chapters.length)
        .map((s) => ({
          id: s.id,
          subject: s.subjects,
          chapters: s.chapters.map(({ study_materials, ...chapter }) => ({
            ...chapter,
            materials: study_materials.map((m) => {
              const p = byMaterial.get(m.id);
              return {
                ...m,
                progress: p?.status ?? 'NOT_STARTED',
                last_accessed_at: p?.last_accessed_at ?? null,
                completed_at: p?.completed_at ?? null,
              };
            }),
          })),
        })),
    };
  }
}
