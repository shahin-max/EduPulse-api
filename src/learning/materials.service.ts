import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { material_progress_status } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccessService } from '../common/access.service.js';
import { AuthUser, hasRole, isStaff, RoleCode } from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { LearningAccessService } from './learning-access.service.js';
import {
  BatchProgressQueryDto,
  CreateStudyMaterialDto,
  UpdateStudyMaterialDto,
} from './dto/learning.dto.js';

const materialInclude = {
  file_assets: {
    select: {
      id: true,
      original_filename: true,
      mime_type: true,
      size_bytes: true,
      visibility: true,
    },
  },
} as const;

/** Mirrors chk_material_location: a material needs a file or a link. */
export function assertMaterialLocation(
  assetId: unknown,
  externalUrl: unknown,
): void {
  const missing = (v: unknown) => v === null || v === undefined || v === '';
  if (missing(assetId) && missing(externalUrl)) {
    throw new BadRequestException(
      'A study material needs an assetId or an externalUrl',
    );
  }
}

/** Timestamps to write when a student reports progress. */
export function progressTimestamps(
  status: material_progress_status,
  previousCompletedAt: Date | null,
  now = new Date(),
) {
  return {
    last_accessed_at: now,
    completed_at: status === 'COMPLETED' ? (previousCompletedAt ?? now) : null,
  };
}

@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly learning: LearningAccessService,
  ) {}

  /** Staff see every material of the chapter; enrolled students see published ones of published chapters. */
  async listForChapter(chapterId: bigint, user: AuthUser) {
    const chapter = await this.learning.chapterWithCourse(chapterId);
    if (!isStaff(user)) {
      await this.assertStudentCanRead(
        user,
        chapter.course_id,
        chapter.is_published,
      );
    }
    return this.prisma.study_materials.findMany({
      where: {
        chapter_id: chapterId,
        ...(isStaff(user) ? {} : { is_published: true }),
      },
      include: materialInclude,
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  async findOne(id: bigint, user: AuthUser) {
    const material = await this.prisma.study_materials.findUnique({
      where: { id },
      include: materialInclude,
    });
    if (!material) throw new NotFoundException('Study material not found');
    if (!isStaff(user)) {
      const chapter = await this.learning.chapterWithCourse(
        material.chapter_id,
      );
      await this.assertStudentCanRead(
        user,
        chapter.course_id,
        chapter.is_published && material.is_published,
      );
    }
    return material;
  }

  async create(dto: CreateStudyMaterialDto, user: AuthUser) {
    assertMaterialLocation(dto.assetId, dto.externalUrl);
    await this.learning.chapterWithCourse(BigInt(dto.chapterId));
    await this.assertAsset(dto.assetId);
    return this.prisma.study_materials.create({
      data: {
        chapter_id: BigInt(dto.chapterId),
        title: dto.title,
        kind: dto.kind,
        asset_id: dto.assetId === undefined ? undefined : BigInt(dto.assetId),
        external_url: dto.externalUrl,
        is_downloadable: dto.isDownloadable,
        is_published: dto.isPublished,
        sort_order: dto.sortOrder,
        created_by: user.id,
      },
      include: materialInclude,
    });
  }

  async update(id: bigint, dto: UpdateStudyMaterialDto) {
    const existing = await this.prisma.study_materials.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Study material not found');
    assertMaterialLocation(
      dto.assetId === undefined ? existing.asset_id : dto.assetId,
      dto.externalUrl === undefined ? existing.external_url : dto.externalUrl,
    );
    await this.assertAsset(dto.assetId);
    return this.prisma.study_materials.update({
      where: { id },
      data: {
        title: dto.title,
        kind: dto.kind,
        asset_id:
          dto.assetId === undefined
            ? undefined
            : dto.assetId === null
              ? null
              : BigInt(dto.assetId),
        external_url: dto.externalUrl,
        is_downloadable: dto.isDownloadable,
        is_published: dto.isPublished,
        sort_order: dto.sortOrder,
      },
      include: materialInclude,
    });
  }

  /** Deletes the material and the students' progress rows for it (the file itself is kept). */
  async remove(id: bigint): Promise<void> {
    const existing = await this.prisma.study_materials.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Study material not found');
    await this.prisma.$transaction([
      this.prisma.material_progress.deleteMany({ where: { material_id: id } }),
      this.prisma.study_materials.delete({ where: { id } }),
    ]);
  }

  /** Records a student's progress against their ACTIVE enrollment in a batch of the material's course. */
  async updateProgress(
    id: bigint,
    status: material_progress_status,
    user: AuthUser,
  ) {
    const material = await this.prisma.study_materials.findUnique({
      where: { id },
    });
    if (!material) throw new NotFoundException('Study material not found');
    const chapter = await this.learning.chapterWithCourse(material.chapter_id);
    const enrollment = await this.assertStudentCanRead(
      user,
      chapter.course_id,
      chapter.is_published && material.is_published,
    );

    const existing = await this.prisma.material_progress.findUnique({
      where: {
        enrollment_id_material_id: {
          enrollment_id: enrollment.id,
          material_id: id,
        },
      },
    });
    const stamps = progressTimestamps(status, existing?.completed_at ?? null);
    return this.prisma.material_progress.upsert({
      where: {
        enrollment_id_material_id: {
          enrollment_id: enrollment.id,
          material_id: id,
        },
      },
      update: { status, ...stamps },
      create: {
        enrollment_id: enrollment.id,
        material_id: id,
        status,
        ...stamps,
      },
    });
  }

  /** The logged-in student's progress across all their enrollments. */
  myProgress(user: AuthUser) {
    return this.prisma.material_progress.findMany({
      where: { enrollments: { student_user_id: user.id } },
      include: {
        study_materials: {
          select: { id: true, title: true, kind: true, chapter_id: true },
        },
        enrollments: { select: { id: true, batch_id: true } },
      },
      orderBy: { last_accessed_at: 'desc' },
    });
  }

  /** Progress of every student in a batch. Admins and the batch's faculty. */
  async batchProgress(query: BatchProgressQueryDto, user: AuthUser) {
    const batchId = BigInt(query.batchId);
    await this.access.assertCanManageBatch(user, batchId);
    const where = { enrollments: { batch_id: batchId } };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.material_progress.findMany({
        where,
        include: {
          study_materials: {
            select: { id: true, title: true, chapter_id: true },
          },
          enrollments: {
            select: {
              id: true,
              student_user_id: true,
              student_profiles: {
                select: { users: { select: { full_name: true } } },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
        ...skipTake(query),
      }),
      this.prisma.material_progress.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** Students need the content published and an ACTIVE enrollment in the course. Returns that enrollment. */
  private async assertStudentCanRead(
    user: AuthUser,
    courseId: bigint,
    published: boolean,
  ) {
    if (!hasRole(user, RoleCode.STUDENT))
      throw new ForbiddenException('You do not have access to these materials');
    const enrollment = await this.learning.studentEnrollmentInCourse(
      user.id,
      courseId,
    );
    if (!enrollment)
      throw new ForbiddenException('You are not enrolled in this course');
    if (!published) throw new NotFoundException('Study material not found');
    return enrollment;
  }

  private async assertAsset(assetId?: number | null): Promise<void> {
    if (assetId === undefined || assetId === null) return;
    const asset = await this.prisma.file_assets.findUnique({
      where: { id: BigInt(assetId) },
      select: { id: true },
    });
    if (!asset)
      throw new BadRequestException('assetId does not match any file');
  }
}
