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
import { admission_enquiries_status } from '../generated/prisma/enums.js';
import { PaginationQueryDto, toBoolean } from '../common/pagination.js';
import {
  lowerTrim,
  MOBILE_MESSAGE,
  MOBILE_REGEX,
  toMobile,
  trim,
} from '../common/validation.js';

// Kept in a *.dto.ts file so the @nestjs/swagger CLI plugin documents these classes in /docs.

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
