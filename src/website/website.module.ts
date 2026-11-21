import { ActivityNotifier } from '../communications/activity-notifier.service.js';
import {
  WebsiteMediaController,
  WebsiteMediaService,
} from './website-media.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { allPages, csvFile } from '../common/csv.js';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { admission_enquiries_status } from '../generated/prisma/enums.js';
import type { AuthUser } from '../common/auth.js';
import {
  BRANCH_ADMIN,
  CurrentUser,
  isAdmin,
  isAnyAdmin,
  isBranchAdmin,
  Public,
  RoleCode,
  Roles,
} from '../common/auth.js';
import { AccessService, branchIn } from '../common/access.service.js';
import {
  PaginationQueryDto,
  paginated,
  skipTake,
  toBoolean,
} from '../common/pagination.js';
import {
  lowerTrim,
  MOBILE_MESSAGE,
  MOBILE_REGEX,
  toMobile,
  trim,
} from '../common/validation.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ---------------------------------------------------------------------------
// Admission enquiries: the website's "Request a callback" form.
// ---------------------------------------------------------------------------

export class CreateEnquiryDto {
  /** @example "Sana Ali" */
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  studentName: string;

  /** @example "+91 98765 43210" */
  @Transform(toMobile)
  @Matches(MOBILE_REGEX, { message: MOBILE_MESSAGE })
  mobile: string;

  @IsOptional()
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** Course of interest; omit for "not sure yet". */
  @IsOptional()
  @IsInt()
  @Min(1)
  interestedCourseId?: number;

  /**
   * Preferred branch. Omitted: the only active branch, or head office routes it when there are
   * several.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  branchId?: number;

  /** @example "Class 9, evening batch preferred" */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  message?: string;

  /** Where the enquiry came from, e.g. WEBSITE, WHATSAPP, WALK_IN, PHONE. Defaults to WEBSITE. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9_]{2,64}$/, {
    message: 'source must be an uppercase label such as WEBSITE or WALK_IN',
  })
  source?: string;
}

export class UpdateEnquiryDto {
  @IsOptional()
  @IsIn(Object.values(admission_enquiries_status))
  status?: admission_enquiries_status;

  /**
   * Admin or faculty user following up; null to unassign. Branch admins assign staff of the
   * enquiry's branch.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  assignedTo?: number | null;

  /** Route the enquiry to a branch (admins; a branch admin only to one of their branches). */
  @IsOptional()
  @IsInt()
  @Min(1)
  branchId?: number;
}

export class AddEnquiryNoteDto {
  /** What happened on the call, e.g. "Asked to call back on Monday after 5 pm". */
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  body: string;
}

export class ListEnquiriesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(Object.values(admission_enquiries_status))
  status?: admission_enquiries_status;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  courseId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  assignedTo?: number;

  /** Only this branch (branch admins: one of theirs; by default all of them). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  /** Head office: only enquiries not routed to a branch yet. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unrouted?: boolean;

  /** Matches name or mobile. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(160)
  search?: string;
}

const enquiryInclude = {
  courses: { select: { id: true, code: true, title: true } },
  users: { select: { id: true, full_name: true } },
  branches: { select: { id: true, code: true, name: true } },
  _count: { select: { enquiry_notes: true } },
} satisfies Prisma.admission_enquiriesInclude;

@Injectable()
export class EnquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ActivityNotifier,
    private readonly access: AccessService,
  ) {}

  async create(dto: CreateEnquiryDto) {
    const branchId = await this.enquiryBranch(dto.branchId);
    if (dto.interestedCourseId !== undefined) {
      const course = await this.prisma.courses.findUnique({
        where: { id: BigInt(dto.interestedCourseId) },
        select: { status: true },
      });
      if (!course || course.status === 'ARCHIVED')
        throw new BadRequestException(
          'interestedCourseId does not match any course',
        );
    }
    const enquiry = await this.prisma.admission_enquiries.create({
      data: {
        student_name: dto.studentName,
        mobile: dto.mobile,
        email: dto.email,
        interested_course_id:
          dto.interestedCourseId === undefined
            ? undefined
            : BigInt(dto.interestedCourseId),
        message: dto.message,
        source: dto.source ?? 'WEBSITE',
        branch_id: branchId,
      },
    });
    await this.notifier.enquiryReceived(enquiry.id);
    // Visitors only get a receipt; staff read the full record.
    return {
      id: enquiry.id,
      status: enquiry.status,
      created_at: enquiry.created_at,
    };
  }

  /**
   * Head office sees every enquiry, branch admins their branches' enquiries, faculty the ones
   * assigned to them.
   */
  async findAll(query: ListEnquiriesQueryDto, actor: AuthUser) {
    const admin = isAnyAdmin(actor);
    const where: Prisma.admission_enquiriesWhereInput = {
      status: query.status,
      interested_course_id:
        query.courseId === undefined ? undefined : BigInt(query.courseId),
      assigned_to: admin
        ? query.assignedTo === undefined
          ? undefined
          : BigInt(query.assignedTo)
        : actor.id,
      ...(admin
        ? query.unrouted && isAdmin(actor)
          ? { branch_id: null }
          : { branch_id: branchIn(this.access.branchScope(actor, query.branchId)) }
        : {}),
      ...(query.search
        ? {
            OR: [
              { student_name: { contains: query.search } },
              { mobile: { contains: query.search.replace(/\s+/g, '') } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.admission_enquiries.findMany({
        where,
        include: enquiryInclude,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.admission_enquiries.count({ where }),
    ]);
    return paginated(data, total, query);
  }

  async findOne(id: bigint, actor: AuthUser) {
    const enquiry = await this.prisma.admission_enquiries.findUnique({
      where: { id },
      include: enquiryInclude,
    });
    if (
      !enquiry ||
      (!this.access.isAdminOfBranch(actor, enquiry.branch_id) &&
        enquiry.assigned_to !== actor.id)
    )
      throw new NotFoundException('Enquiry not found');
    return enquiry;
  }

  /**
   * Admins of the enquiry's branch (or head office) update anything; the assigned person may
   * only change the status.
   */
  async update(id: bigint, dto: UpdateEnquiryDto, actor: AuthUser) {
    const before = await this.findOne(id, actor);
    const admin = this.access.isAdminOfBranch(actor, before.branch_id);
    if (!admin && (dto.assignedTo !== undefined || dto.branchId !== undefined))
      throw new BadRequestException(
        'Only admins can reassign or reroute enquiries',
      );
    const branchId =
      dto.branchId === undefined ? before.branch_id : BigInt(dto.branchId);
    if (dto.branchId !== undefined) {
      this.access.assertBranchAdmin(actor, branchId);
      await this.enquiryBranch(dto.branchId);
    }
    if (dto.assignedTo !== undefined && dto.assignedTo !== null) {
      const assignee = await this.prisma.users.findUnique({
        where: { id: BigInt(dto.assignedTo) },
        select: {
          status: true,
          deleted_at: true,
          user_roles: { select: { roles: { select: { code: true } } } },
          branch_staff: {
            where: { roles: { code: RoleCode.ADMIN } },
            select: { branch_id: true },
          },
        },
      });
      const staff =
        assignee?.user_roles.some(
          (ur) =>
            ur.roles.code === RoleCode.ADMIN ||
            ur.roles.code === RoleCode.FACULTY,
        ) || !!assignee?.branch_staff.length;
      if (
        !assignee ||
        !staff ||
        assignee.status !== 'ACTIVE' ||
        assignee.deleted_at
      ) {
        throw new BadRequestException(
          'assignedTo must be an active admin or faculty member',
        );
      }
      // A branch admin hands enquiries to the people of that branch (or keeps them).
      if (isBranchAdmin(actor) && BigInt(dto.assignedTo) !== actor.id) {
        const atBranch = await this.prisma.branch_staff.findFirst({
          where: { user_id: BigInt(dto.assignedTo), branch_id: branchId! },
          select: { user_id: true },
        });
        if (!atBranch)
          throw new BadRequestException(
            "assignedTo must be on this branch's staff",
          );
      }
    }
    const updated = await this.prisma.admission_enquiries.update({
      where: { id },
      data: {
        status: dto.status,
        branch_id: dto.branchId === undefined ? undefined : branchId,
        assigned_to:
          dto.assignedTo === undefined
            ? undefined
            : dto.assignedTo === null
              ? null
              : BigInt(dto.assignedTo),
      },
      include: enquiryInclude,
    });
    if (
      updated.assigned_to !== null &&
      updated.assigned_to !== before.assigned_to
    )
      await this.notifier.enquiryAssigned(id, updated.assigned_to, actor.id);
    return updated;
  }

  /** Call notes, oldest first. Same access as the enquiry: its admins, or the assigned person. */
  async notes(id: bigint, actor: AuthUser) {
    await this.findOne(id, actor);
    return this.prisma.enquiry_notes.findMany({
      where: { enquiry_id: id },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        body: true,
        created_at: true,
        users: { select: { id: true, full_name: true } },
      },
    });
  }

  /**
   * The branch for an enquiry: the one given (must be active), else the only active branch, else
   * none (head office routes it).
   */
  private async enquiryBranch(branchId?: number): Promise<bigint | null> {
    if (branchId !== undefined) {
      const branch = await this.prisma.branches.findUnique({
        where: { id: BigInt(branchId) },
        select: { id: true, is_active: true },
      });
      if (!branch || !branch.is_active)
        throw new BadRequestException('branchId does not match any branch');
      return branch.id;
    }
    const active = await this.prisma.branches.findMany({
      where: { is_active: true },
      select: { id: true },
      take: 2,
    });
    return active.length === 1 ? active[0].id : null;
  }

  async addNote(id: bigint, dto: AddEnquiryNoteDto, actor: AuthUser) {
    const enquiry = await this.findOne(id, actor);
    const [note] = await this.prisma.$transaction([
      this.prisma.enquiry_notes.create({
        data: { enquiry_id: id, author_id: actor.id, body: dto.body },
        select: {
          id: true,
          body: true,
          created_at: true,
          users: { select: { id: true, full_name: true } },
        },
      }),
      // A first call moves a NEW enquiry to CONTACTED, so the list reflects that someone called.
      ...(enquiry.status === 'NEW'
        ? [
            this.prisma.admission_enquiries.update({
              where: { id },
              data: { status: 'CONTACTED' },
            }),
          ]
        : []),
    ]);
    return note;
  }
}

@ApiTags('Admission enquiries')
@Controller('admission-enquiries')
export class EnquiriesController {
  constructor(private readonly enquiries: EnquiriesService) {}

  /** Submit a callback request from the website (rate limited). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@Body() dto: CreateEnquiryDto) {
    return this.enquiries.create(dto);
  }

  /**
   * Head office sees all enquiries (`unrouted=true`: the ones without a branch), branch admins
   * their branches', faculty the ones assigned to them.
   */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get()
  findAll(
    @Query() query: ListEnquiriesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.findAll(query, user);
  }

  /** The enquiry list as a CSV download (same filters and branches as the list). Admins only. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN)
  @ApiProduces('text/csv')
  @Get('export')
  async export(
    @Query() query: ListEnquiriesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    const rows = await allPages((page, limit) =>
      this.enquiries.findAll(
        Object.assign(new ListEnquiriesQueryDto(), query, { page, limit }),
        user,
      ),
    );
    return csvFile(
      'enquiries',
      [
        'Received',
        'Name',
        'Mobile',
        'Email',
        'Course',
        'Branch',
        'Status',
        'Assigned to',
        'Source',
        'Call notes',
        'Message',
      ],
      rows.map((e) => [
        e.created_at,
        e.student_name,
        e.mobile,
        e.email,
        e.courses?.title,
        e.branches?.name,
        e.status,
        e.users?.full_name,
        e.source,
        e._count.enquiry_notes,
        e.message,
      ]),
    );
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.findOne(BigInt(id), user);
  }

  /** Call notes on the enquiry, oldest first. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Get(':id/notes')
  notes(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.enquiries.notes(BigInt(id), user);
  }

  /** Add a call note. The first note on a NEW enquiry marks it CONTACTED. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Post(':id/notes')
  addNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AddEnquiryNoteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.addNote(BigInt(id), dto, user);
  }

  /** Update follow-up status (NEW, CONTACTED, FOLLOW_UP, CONVERTED, CLOSED), assignee or branch. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, BRANCH_ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateEnquiryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.update(BigInt(id), dto, user);
  }
}

// ---------------------------------------------------------------------------
// Website content: editable blocks of the public site, addressed by key.
// ---------------------------------------------------------------------------

export class UpsertContentDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  title?: string | null;

  /** HTML or Markdown, as the frontend expects. */
  @IsOptional()
  @IsString()
  @MaxLength(1_000_000)
  body?: string | null;

  /** A PUBLIC file asset. */
  @IsOptional()
  @IsInt()
  @Min(1)
  imageAssetId?: number | null;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class ListContentQueryDto {
  /** Only keys starting with this prefix, e.g. "home." */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  prefix?: string;

  /** Admins only: include unpublished entries. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeUnpublished?: boolean;
}

const CONTENT_KEY = /^[a-z0-9][a-z0-9._-]{0,99}$/;

@Injectable()
export class WebsiteContentService {
  constructor(private readonly prisma: PrismaService) {}

  list(query: ListContentQueryDto, admin: boolean) {
    return this.prisma.website_content.findMany({
      where: {
        ...(query.prefix ? { content_key: { startsWith: query.prefix } } : {}),
        ...(admin && query.includeUnpublished ? {} : { is_published: true }),
      },
      orderBy: [{ sort_order: 'asc' }, { content_key: 'asc' }],
    });
  }

  async get(key: string, admin: boolean) {
    const entry = await this.prisma.website_content.findUnique({
      where: { content_key: key },
    });
    if (!entry || (!entry.is_published && !admin))
      throw new NotFoundException('Content not found');
    return entry;
  }

  async upsert(key: string, dto: UpsertContentDto, actorId: bigint) {
    if (!CONTENT_KEY.test(key)) {
      throw new BadRequestException(
        'key must be lowercase letters, digits, ".", "_" or "-" (max 100), e.g. home.hero',
      );
    }
    if (dto.imageAssetId !== undefined && dto.imageAssetId !== null) {
      const asset = await this.prisma.file_assets.findUnique({
        where: { id: BigInt(dto.imageAssetId) },
        select: { visibility: true },
      });
      if (!asset)
        throw new BadRequestException('imageAssetId does not match any file');
      if (asset.visibility !== 'PUBLIC')
        throw new BadRequestException('Website images must be PUBLIC files');
    }
    const data = {
      title: dto.title,
      body: dto.body,
      image_asset_id:
        dto.imageAssetId === undefined
          ? undefined
          : dto.imageAssetId === null
            ? null
            : BigInt(dto.imageAssetId),
      is_published: dto.isPublished,
      sort_order: dto.sortOrder,
      updated_by: actorId,
    };
    return this.prisma.website_content.upsert({
      where: { content_key: key },
      update: data,
      create: { ...data, content_key: key },
    });
  }

  async remove(key: string): Promise<void> {
    await this.prisma.website_content.delete({ where: { content_key: key } });
  }
}

@ApiTags('Website content')
@Controller('website-content')
export class WebsiteContentController {
  constructor(private readonly content: WebsiteContentService) {}

  /** Published content blocks, optionally filtered by key prefix. */
  @Public()
  @Get()
  list(@Query() query: ListContentQueryDto, @CurrentUser() user?: AuthUser) {
    return this.content.list(query, isAdmin(user));
  }

  /** One block by key, e.g. "home.hero". */
  @Public()
  @Get(':key')
  get(@Param('key') key: string, @CurrentUser() user?: AuthUser) {
    return this.content.get(key, isAdmin(user));
  }

  /** Create or replace the fields of a block. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @Put(':key')
  upsert(
    @Param('key') key: string,
    @Body() dto: UpsertContentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.content.upsert(key, dto, user.id);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.content.remove(key);
  }
}

@Module({
  // The media controller is listed first so POST website-content/images is not read as a key.
  controllers: [
    EnquiriesController,
    WebsiteMediaController,
    WebsiteContentController,
  ],
  providers: [EnquiriesService, WebsiteContentService, WebsiteMediaService],
})
export class WebsiteModule {}
