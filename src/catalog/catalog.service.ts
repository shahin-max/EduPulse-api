import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toId } from '../common/validation.js';
import {
  CreateChapterDto,
  CreateCourseDto,
  CreateSubjectDto,
  UpdateChapterDto,
  UpdateCourseDto,
  UpdateSubjectDto,
} from './dto/catalog.dto.js';

/** Statuses a visitor may see. */
const PUBLIC_COURSE = { status: 'PUBLISHED' } as const;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Subjects ----

  listSubjects() {
    return this.prisma.subjects.findMany({ orderBy: { name: 'asc' } });
  }

  createSubject(dto: CreateSubjectDto) {
    return this.prisma.subjects.create({ data: dto });
  }

  async updateSubject(id: bigint, dto: UpdateSubjectDto) {
    return this.prisma.subjects.update({ where: { id }, data: dto });
  }

  /** 409 while any course, batch, class, exam or assignment still uses the subject. */
  async removeSubject(id: bigint): Promise<void> {
    await this.prisma.subjects.delete({ where: { id } });
  }

  // ---- Courses ----

  listCourses(includeAll: boolean) {
    return this.prisma.courses.findMany({
      where: includeAll ? {} : PUBLIC_COURSE,
      orderBy: [{ sort_order: 'asc' }, { title: 'asc' }],
      include: {
        course_subjects: {
          orderBy: { sort_order: 'asc' },
          include: { subjects: true },
        },
      },
    });
  }

  /** By numeric id or slug. Non-published courses are hidden unless `staff`. */
  async getCourse(idOrSlug: string, staff: boolean) {
    const where = /^\d+$/.test(idOrSlug)
      ? { id: BigInt(idOrSlug) }
      : { slug: idOrSlug.toLowerCase() };
    const course = await this.prisma.courses.findUnique({
      where,
      include: {
        course_subjects: {
          orderBy: { sort_order: 'asc' },
          include: { subjects: true },
        },
      },
    });
    if (!course || (!staff && course.status !== 'PUBLISHED'))
      throw new NotFoundException('Course not found');
    return course;
  }

  async createCourse(dto: CreateCourseDto, actorId: bigint) {
    await this.assertThumbnail(dto.thumbnailAssetId);
    const { thumbnailAssetId, sortOrder, ...rest } = dto;
    return this.prisma.courses.create({
      data: {
        ...rest,
        thumbnail_asset_id: toId(thumbnailAssetId),
        sort_order: sortOrder,
        created_by: actorId,
      },
    });
  }

  async updateCourse(id: bigint, dto: UpdateCourseDto) {
    await this.assertThumbnail(dto.thumbnailAssetId);
    const { thumbnailAssetId, sortOrder, ...rest } = dto;
    return this.prisma.courses.update({
      where: { id },
      data: {
        ...rest,
        thumbnail_asset_id: toId(thumbnailAssetId),
        sort_order: sortOrder,
      },
    });
  }

  /** Only courses nothing refers to can be deleted; archive the rest (status ARCHIVED). */
  async removeCourse(id: bigint): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const subjectLinks = await tx.course_subjects.findMany({
        where: { course_id: id },
        select: { id: true },
      });
      const csIds = subjectLinks.map((cs) => cs.id);
      const chapters = await tx.chapters.count({
        where: { course_subject_id: { in: csIds } },
      });
      if (chapters)
        throw new ConflictException(
          'Delete the course chapters first, or archive the course',
        );
      await tx.course_subjects.deleteMany({ where: { course_id: id } });
      await tx.courses.delete({ where: { id } });
    });
  }

  /** Full syllabus: subjects with their chapters. Visitors only see published chapters of published courses. */
  async curriculum(idOrSlug: string, staff: boolean) {
    const course = await this.getCourse(idOrSlug, staff);
    const subjects = await this.prisma.course_subjects.findMany({
      where: { course_id: course.id },
      orderBy: { sort_order: 'asc' },
      include: {
        subjects: true,
        chapters: {
          where: staff ? {} : { is_published: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    return {
      course: {
        id: course.id,
        code: course.code,
        slug: course.slug,
        title: course.title,
      },
      subjects,
    };
  }

  async attachSubject(courseId: bigint, subjectId: bigint, sortOrder?: number) {
    await this.prisma.courses
      .findUniqueOrThrow({ where: { id: courseId } })
      .catch(() => {
        throw new NotFoundException('Course not found');
      });
    await this.prisma.subjects
      .findUniqueOrThrow({ where: { id: subjectId } })
      .catch(() => {
        throw new NotFoundException('Subject not found');
      });
    return this.prisma.course_subjects.upsert({
      where: {
        course_id_subject_id: { course_id: courseId, subject_id: subjectId },
      },
      update: { sort_order: sortOrder },
      create: {
        course_id: courseId,
        subject_id: subjectId,
        sort_order: sortOrder,
      },
      include: { subjects: true },
    });
  }

  /** 409 while chapters or questions belong to this course subject. */
  async detachSubject(courseId: bigint, subjectId: bigint): Promise<void> {
    await this.prisma.course_subjects.delete({
      where: {
        course_id_subject_id: { course_id: courseId, subject_id: subjectId },
      },
    });
  }

  // ---- Chapters ----

  async createChapter(dto: CreateChapterDto) {
    const cs = await this.prisma.course_subjects.findUnique({
      where: {
        course_id_subject_id: {
          course_id: BigInt(dto.courseId),
          subject_id: BigInt(dto.subjectId),
        },
      },
    });
    if (!cs)
      throw new BadRequestException(
        'This subject is not part of the course; attach it first',
      );
    return this.prisma.chapters.create({
      data: {
        course_subject_id: cs.id,
        title: dto.title,
        description: dto.description,
        sort_order: dto.sortOrder,
        is_published: dto.isPublished,
      },
    });
  }

  async getChapter(id: bigint, staff: boolean) {
    const chapter = await this.prisma.chapters.findUnique({
      where: { id },
      include: {
        course_subjects: {
          include: {
            subjects: true,
            courses: {
              select: { id: true, slug: true, title: true, status: true },
            },
          },
        },
      },
    });
    if (
      !chapter ||
      (!staff &&
        (!chapter.is_published ||
          chapter.course_subjects.courses.status !== 'PUBLISHED'))
    ) {
      throw new NotFoundException('Chapter not found');
    }
    return chapter;
  }

  updateChapter(id: bigint, dto: UpdateChapterDto) {
    const data: Prisma.chaptersUpdateInput = {
      title: dto.title,
      description: dto.description,
      sort_order: dto.sortOrder,
      is_published: dto.isPublished,
    };
    return this.prisma.chapters.update({ where: { id }, data });
  }

  /** 409 while study materials or questions belong to the chapter. */
  async removeChapter(id: bigint): Promise<void> {
    await this.prisma.chapters.delete({ where: { id } });
  }

  private async assertThumbnail(assetId?: number | null): Promise<void> {
    if (assetId === undefined || assetId === null) return;
    const asset = await this.prisma.file_assets.findUnique({
      where: { id: BigInt(assetId) },
      select: { visibility: true },
    });
    if (!asset)
      throw new BadRequestException('thumbnailAssetId does not match any file');
    if (asset.visibility !== 'PUBLIC')
      throw new BadRequestException('A course thumbnail must be a PUBLIC file');
  }
}
