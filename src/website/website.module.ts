import { ActivityNotifier } from '../communications/activity-notifier.service.js';
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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  CurrentUser,
  isAdmin,
  Public,
  RoleCode,
  Roles,
} from '../common/auth.js';
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

  /** Admin or faculty user following up; null to unassign. */
  @IsOptional()
  @IsInt()
  @Min(1)
  assignedTo?: number | null;
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
} satisfies Prisma.admission_enquiriesInclude;

@Injectable()
export class EnquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: ActivityNotifier,
  ) {}

  async create(dto: CreateEnquiryDto) {
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
      },
    });
    // Visitors only get a receipt; staff read the full record.
    return {
      id: enquiry.id,
      status: enquiry.status,
      created_at: enquiry.created_at,
    };
  }

  /** Faculty only see enquiries assigned to them. */
  async findAll(query: ListEnquiriesQueryDto, actor: AuthUser) {
    const where: Prisma.admission_enquiriesWhereInput = {
      status: query.status,
      interested_course_id:
        query.courseId === undefined ? undefined : BigInt(query.courseId),
      assigned_to: isAdmin(actor)
        ? query.assignedTo === undefined
          ? undefined
          : BigInt(query.assignedTo)
        : actor.id,
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
    if (!enquiry || (!isAdmin(actor) && enquiry.assigned_to !== actor.id))
      throw new NotFoundException('Enquiry not found');
    return enquiry;
  }

  /** Admins update anything; assigned faculty may only change the status. */
  async update(id: bigint, dto: UpdateEnquiryDto, actor: AuthUser) {
    const before = await this.findOne(id, actor);
    if (!isAdmin(actor) && dto.assignedTo !== undefined)
      throw new BadRequestException('Only admins can reassign enquiries');
    if (dto.assignedTo !== undefined && dto.assignedTo !== null) {
      const assignee = await this.prisma.users.findUnique({
        where: { id: BigInt(dto.assignedTo) },
        select: {
          status: true,
          deleted_at: true,
          user_roles: { select: { roles: { select: { code: true } } } },
        },
      });
      const staff = assignee?.user_roles.some(
        (ur) =>
          ur.roles.code === RoleCode.ADMIN ||
          ur.roles.code === RoleCode.FACULTY,
      );
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
    }
    const updated = await this.prisma.admission_enquiries.update({
      where: { id },
      data: {
        status: dto.status,
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

  /** Admins see all enquiries; faculty see the ones assigned to them. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get()
  findAll(
    @Query() query: ListEnquiriesQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.findAll(query, user);
  }

  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.enquiries.findOne(BigInt(id), user);
  }

  /** Update follow-up status (NEW, CONTACTED, FOLLOW_UP, CONVERTED, CLOSED) or assignee. */
  @ApiBearerAuth()
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
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
  controllers: [EnquiriesController, WebsiteContentController],
  providers: [EnquiriesService, WebsiteContentService],
})
export class WebsiteModule {}
