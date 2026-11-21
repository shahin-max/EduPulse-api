import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { announcements_audience } from '../generated/prisma/enums.js';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { jobsEnabled } from '../jobs/jobs-config.js';
import {
  AccessService,
  currentEnrollmentWhere,
} from '../common/access.service.js';
import {
  AuthUser,
  isAdmin,
  isBranchAdmin,
  RoleCode,
} from '../common/auth.js';
import { paginated, skipTake } from '../common/pagination.js';
import { NotificationsService } from './notifications.service.js';
import {
  announcementLink,
  audienceFilter,
  batchRuleError,
  canSee,
} from './audience.js';
import {
  CreateAnnouncementDto,
  FeedQueryDto,
  ListAnnouncementsQueryDto,
  UpdateAnnouncementDto,
} from './dto/communications.dto.js';

const announcementInclude = {
  batches: { select: { id: true, code: true, name: true, branch_id: true } },
  branches: { select: { id: true, code: true, name: true } },
  users: { select: { id: true, full_name: true } },
} satisfies Prisma.announcementsInclude;

/** Scheduled announcements are picked up by the lazy dispatcher for this long after publish_at. */
const DISPATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const LAZY_DISPATCH_EVERY_MS = 60 * 1000;

/**
 * Announcements and their notification fan-out.
 *
 * Scheduled announcements (publish_at in the future) stay out of feeds until publish_at, and
 * notify their audience only once due: on publish, and from the every-minute job (or, with jobs
 * off, at most once a minute when anyone reads their feed or notifications). A dispatch is recorded by the notifications it creates (link_url
 * "/announcements/:id"), which keeps it idempotent; dispatches are serialised in-process
 * (fine for a single API instance; use a job queue/lock if the API is scaled out).
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);
  private lastLazyDispatch = 0;
  private dispatching: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateAnnouncementDto, user: AuthUser) {
    const batchId = dto.batchId === undefined ? null : BigInt(dto.batchId);
    const branchId = dto.branchId === undefined ? null : BigInt(dto.branchId);
    await this.assertMayPost(user, dto.audience, batchId, branchId);
    const announcement = await this.prisma.announcements.create({
      data: {
        title: dto.title,
        body: dto.body,
        audience: dto.audience,
        batch_id: batchId,
        branch_id: branchId,
        publish_at: dto.publishAt ?? (dto.publish ? new Date() : null),
        status: dto.publish ? 'PUBLISHED' : 'DRAFT',
        created_by: user.id,
      },
      include: announcementInclude,
    });
    if (dto.publish) await this.dispatchIfDue(announcement.id);
    return announcement;
  }

  /**
   * Management list: head office sees all; branch admins their own and those for their branches
   * and their batches; faculty the ones they wrote.
   */
  async list(query: ListAnnouncementsQueryDto, user: AuthUser) {
    const branches = user.adminBranchIds ?? [];
    const where: Prisma.announcementsWhereInput = {
      status: query.status,
      audience: query.audience,
      batch_id: query.batchId === undefined ? undefined : BigInt(query.batchId),
      ...(isAdmin(user)
        ? {}
        : isBranchAdmin(user)
          ? {
              OR: [
                { created_by: user.id },
                { branch_id: { in: branches } },
                { batches: { branch_id: { in: branches } } },
              ],
            }
          : { created_by: user.id }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.announcements.findMany({
        where,
        include: announcementInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.announcements.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** Published, due announcements addressed to the user, newest first. */
  async feed(query: FeedQueryDto, user: AuthUser) {
    const batchIds = await this.access.visibleBatchIds(user);
    const branchIds = await this.memberBranchIds(user, batchIds);
    const now = new Date();
    const where: Prisma.announcementsWhereInput = {
      status: 'PUBLISHED',
      OR: [{ publish_at: null }, { publish_at: { lte: now } }],
      AND: [
        {
          OR: audienceFilter(
            user.roles,
            batchIds,
            branchIds,
            isBranchAdmin(user),
          ),
        },
      ],
      ...(query.batchId === undefined
        ? {}
        : { batch_id: BigInt(query.batchId) }),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.announcements.findMany({
        where,
        include: announcementInclude,
        orderBy: [{ publish_at: 'desc' }, { id: 'desc' }],
        ...skipTake(query),
      }),
      this.prisma.announcements.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  /** Authors and admins see any state; everyone else only published, due announcements for them. */
  async findOne(id: bigint, user: AuthUser) {
    const announcement = await this.get(id);
    if (this.mayManage(announcement, user)) return announcement;
    const due =
      announcement.status === 'PUBLISHED' &&
      (!announcement.publish_at || announcement.publish_at <= new Date());
    const batchIds = await this.access.visibleBatchIds(user);
    if (
      due &&
      canSee(
        announcement,
        user.roles,
        batchIds,
        await this.memberBranchIds(user, batchIds),
        isBranchAdmin(user),
      )
    )
      return announcement;
    throw new NotFoundException('Announcement not found');
  }

  async update(id: bigint, dto: UpdateAnnouncementDto, user: AuthUser) {
    const announcement = await this.getManaged(id, user);
    if (announcement.status === 'ARCHIVED')
      throw new BadRequestException('Archived announcements cannot be edited');
    const audience = dto.audience ?? announcement.audience;
    const batchId =
      dto.batchId === undefined
        ? announcement.batch_id
        : dto.batchId === null
          ? null
          : BigInt(dto.batchId);
    const branchId =
      dto.branchId === undefined
        ? announcement.branch_id
        : dto.branchId === null
          ? null
          : BigInt(dto.branchId);
    if (
      dto.audience !== undefined ||
      dto.batchId !== undefined ||
      dto.branchId !== undefined
    )
      await this.assertMayPost(user, audience, batchId, branchId);
    const updated = await this.prisma.announcements.update({
      where: { id },
      data: {
        title: dto.title,
        body: dto.body,
        audience,
        batch_id: batchId,
        branch_id: branchId,
        publish_at: dto.publishAt,
      },
      include: announcementInclude,
    });
    if (updated.status === 'PUBLISHED') await this.dispatchIfDue(id);
    return updated;
  }

  async publish(id: bigint, user: AuthUser) {
    const announcement = await this.getManaged(id, user);
    if (announcement.status === 'PUBLISHED')
      throw new BadRequestException('Announcement is already published');
    await this.assertMayPost(
      user,
      announcement.audience,
      announcement.batch_id,
      announcement.branch_id,
    );
    const updated = await this.prisma.announcements.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publish_at: announcement.publish_at ?? new Date(),
      },
      include: announcementInclude,
    });
    await this.dispatchIfDue(id);
    return updated;
  }

  async archive(id: bigint, user: AuthUser) {
    await this.getManaged(id, user);
    return this.prisma.announcements.update({
      where: { id },
      data: { status: 'ARCHIVED' },
      include: announcementInclude,
    });
  }

  async remove(id: bigint, user: AuthUser): Promise<void> {
    const announcement = await this.getManaged(id, user);
    if (!isAdmin(user) && announcement.status !== 'DRAFT') {
      throw new ForbiddenException(
        'Only drafts can be deleted by their author; archive it instead',
      );
    }
    await this.prisma.announcements.delete({ where: { id } });
  }

  /**
   * Fallback when background jobs are off (JOBS_ENABLED=false): called on feed/notification reads,
   * dispatches due scheduled announcements at most once a minute. Otherwise the every-minute job
   * does it (src/jobs/jobs.ts).
   */
  async dispatchDueLazily(): Promise<void> {
    if (jobsEnabled(this.config)) return;
    if (Date.now() - this.lastLazyDispatch < LAZY_DISPATCH_EVERY_MS) return;
    this.lastLazyDispatch = Date.now();
    try {
      await this.dispatchDue();
    } catch (error) {
      this.logger.error(`Lazy announcement dispatch failed: ${String(error)}`);
    }
  }

  /** Fans out every published announcement that is due and has not notified anyone yet. */
  async dispatchDue(): Promise<number> {
    const now = new Date();
    const due = await this.prisma.announcements.findMany({
      where: {
        status: 'PUBLISHED',
        publish_at: {
          lte: now,
          gte: new Date(now.getTime() - DISPATCH_WINDOW_MS),
        },
      },
      select: { id: true },
    });
    let sent = 0;
    for (const { id } of due) sent += await this.dispatchIfDue(id);
    return sent;
  }

  /** Notifies the audience once, if the announcement is published and due. Returns notifications created. */
  dispatchIfDue(id: bigint): Promise<number> {
    const run = this.dispatching.then(() => this.dispatchNow(id));
    this.dispatching = run.catch(() => undefined);
    return run;
  }

  private async dispatchNow(id: bigint): Promise<number> {
    const announcement = await this.prisma.announcements.findUnique({
      where: { id },
    });
    if (!announcement || announcement.status !== 'PUBLISHED') return 0;
    if (announcement.publish_at && announcement.publish_at > new Date())
      return 0;
    const link = announcementLink(id);
    const already = await this.prisma.notifications.findFirst({
      where: { link_url: link },
      select: { id: true },
    });
    if (already) return 0;
    // The author already knows; everyone else in the audience is notified.
    const recipients = (
      await this.recipients(
        announcement.audience,
        announcement.batch_id,
        announcement.branch_id,
      )
    ).filter((userId) => userId !== announcement.created_by);
    const message =
      announcement.body.length > 500
        ? `${announcement.body.slice(0, 497)}...`
        : announcement.body;
    return this.notifications.notify(recipients, {
      title: announcement.title,
      message,
      linkUrl: link,
      email: true,
    });
  }

  /**
   * Active users in the audience. BATCH = actively enrolled students plus the batch's faculty.
   * BRANCH = students currently enrolled at the branch, the faculty of its batches and its staff.
   * ADMINS includes branch admins.
   */
  async recipients(
    audience: announcements_audience,
    batchId: bigint | null,
    branchId: bigint | null = null,
  ): Promise<bigint[]> {
    const active: Prisma.usersWhereInput = {
      status: 'ACTIVE',
      deleted_at: null,
    };
    const byRole = async (code: RoleCode) =>
      (
        await this.prisma.users.findMany({
          where: { ...active, user_roles: { some: { roles: { code } } } },
          select: { id: true },
        })
      ).map((u) => u.id);
    switch (audience) {
      case 'ALL':
        return (
          await this.prisma.users.findMany({
            where: active,
            select: { id: true },
          })
        ).map((u) => u.id);
      case 'ADMINS':
        return (
          await this.prisma.users.findMany({
            where: {
              ...active,
              OR: [
                { user_roles: { some: { roles: { code: RoleCode.ADMIN } } } },
                {
                  branch_staff: {
                    some: {
                      roles: { code: RoleCode.ADMIN },
                      branches: { is_active: true },
                    },
                  },
                },
              ],
            },
            select: { id: true },
          })
        ).map((u) => u.id);
      case 'FACULTY':
        return byRole(RoleCode.FACULTY);
      case 'STUDENTS':
        return byRole(RoleCode.STUDENT);
      case 'BATCH': {
        if (batchId === null) return [];
        const [students, faculty] = await Promise.all([
          this.prisma.enrollments.findMany({
            where: {
              batch_id: batchId,
              ...currentEnrollmentWhere(),
              student_profiles: { users: active },
            },
            select: { student_user_id: true },
          }),
          this.prisma.batch_faculty.findMany({
            where: { batch_id: batchId, faculty_profiles: { users: active } },
            select: { faculty_user_id: true },
          }),
        ]);
        return [
          ...students.map((s) => s.student_user_id),
          ...faculty.map((f) => f.faculty_user_id),
        ];
      }
      case 'BRANCH': {
        if (branchId === null) return [];
        const users = await this.prisma.users.findMany({
          where: {
            ...active,
            OR: [
              {
                student_profiles: {
                  enrollments: {
                    some: { branch_id: branchId, ...currentEnrollmentWhere() },
                  },
                },
              },
              {
                faculty_profiles: {
                  batch_faculty: { some: { batches: { branch_id: branchId } } },
                },
              },
              { branch_staff: { some: { branch_id: branchId } } },
            ],
          },
          select: { id: true },
        });
        return users.map((u) => u.id);
      }
    }
  }

  private async assertMayPost(
    user: AuthUser,
    audience: announcements_audience,
    batchId: bigint | null,
    branchId: bigint | null = null,
  ): Promise<void> {
    const rule = batchRuleError(audience, batchId, branchId);
    if (rule) throw new BadRequestException(rule);
    if (batchId !== null) await this.access.assertBatchExists(batchId);
    if (branchId !== null) {
      const branch = await this.prisma.branches.findUnique({
        where: { id: branchId },
        select: { id: true },
      });
      if (!branch)
        throw new BadRequestException('branchId does not match any branch');
    }
    if (isAdmin(user)) return;
    if (audience === 'BRANCH' && isBranchAdmin(user)) {
      this.access.assertBranchAdmin(user, branchId);
      return;
    }
    if (audience !== 'BATCH')
      throw new ForbiddenException(
        isBranchAdmin(user)
          ? 'Branch admins post to their branch or to one of its batches'
          : 'Faculty can only post announcements to a batch',
      );
    await this.access.assertCanManageBatch(user, batchId!);
  }

  /** Head office, the author, or an admin of the branch the announcement is for. */
  private mayManage(
    announcement: {
      created_by: bigint | null;
      branch_id: bigint | null;
      batches: { branch_id: bigint } | null;
    },
    user: AuthUser,
  ): boolean {
    if (isAdmin(user)) return true;
    if (announcement.created_by !== null && announcement.created_by === user.id)
      return true;
    const branchId =
      announcement.branch_id ?? announcement.batches?.branch_id ?? null;
    return isBranchAdmin(user) && this.access.isAdminOfBranch(user, branchId);
  }

  /**
   * Branches whose BRANCH announcements the user reads: every branch for head office; otherwise
   * the branches they work at and those of the batches they teach or study in.
   */
  private async memberBranchIds(
    user: AuthUser,
    batchIds: bigint[] | 'all',
  ): Promise<bigint[] | 'all'> {
    if (isAdmin(user)) return 'all';
    const ids = new Set<bigint>(user.adminBranchIds ?? []);
    for (const row of await this.prisma.branch_staff.findMany({
      where: { user_id: user.id },
      select: { branch_id: true },
    }))
      ids.add(row.branch_id);
    if (batchIds !== 'all' && batchIds.length) {
      for (const row of await this.prisma.batches.findMany({
        where: { id: { in: batchIds } },
        select: { branch_id: true },
        distinct: ['branch_id'],
      }))
        ids.add(row.branch_id);
    }
    return [...ids];
  }

  private async get(id: bigint) {
    const announcement = await this.prisma.announcements.findUnique({
      where: { id },
      include: announcementInclude,
    });
    if (!announcement) throw new NotFoundException('Announcement not found');
    return announcement;
  }

  private async getManaged(id: bigint, user: AuthUser) {
    const announcement = await this.get(id);
    if (!this.mayManage(announcement, user))
      throw new NotFoundException('Announcement not found');
    return announcement;
  }
}
