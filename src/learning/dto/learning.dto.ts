import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  assignments_status,
  file_assets_visibility,
  material_progress_status,
  study_materials_kind,
} from '../../generated/prisma/enums.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { AtLeastOneOf, trim } from '../../common/validation.js';

// ---- Files ----

export class UploadFileDto {
  /**
   * PUBLIC files (course thumbnails, website images) can be downloaded by anyone.
   * PRIVATE files (notes, submissions) only by people who can reach them. Defaults to PRIVATE.
   */
  @IsOptional()
  @IsIn(Object.values(file_assets_visibility))
  visibility?: file_assets_visibility;
}

// ---- Study materials ----

export class CreateStudyMaterialDto {
  @IsInt()
  @Min(1)
  chapterId: number;

  /** @example "Laws of Motion - class notes" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsIn(Object.values(study_materials_kind))
  kind: study_materials_kind;

  /** An uploaded file. Either assetId or externalUrl is required. */
  @AtLeastOneOf(['assetId', 'externalUrl'])
  @IsOptional()
  @IsInt()
  @Min(1)
  assetId?: number;

  /** e.g. a YouTube link for VIDEO_LINK materials. */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  externalUrl?: string;

  /** Whether students may download the file (the app decides how to honour this). */
  @IsOptional()
  @IsBoolean()
  isDownloadable?: boolean;

  /** Unpublished materials are only visible to admins and faculty. */
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateStudyMaterialDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @IsIn(Object.values(study_materials_kind))
  kind?: study_materials_kind;

  /** null removes the file (then externalUrl must remain set). */
  @IsOptional()
  @IsInt()
  @Min(1)
  assetId?: number | null;

  /** null removes the link (then assetId must remain set). */
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  externalUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isDownloadable?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class ListStudyMaterialsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterId: number;
}

export class UpdateProgressDto {
  @IsIn(Object.values(material_progress_status))
  status: material_progress_status;
}

export class BatchProgressQueryDto extends PaginationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  batchId: number;
}

// ---- Assignments ----

const MARKS = { maxDecimalPlaces: 2 } as const;

export class CreateAssignmentDto {
  @IsInt()
  @Min(1)
  batchId: number;

  /** Must be one of the batch's course subjects. */
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number;

  /** @example "Worksheet 3: Kinematics" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string;

  /** An uploaded file with the question paper or worksheet. */
  @IsOptional()
  @IsInt()
  @Min(1)
  attachmentAssetId?: number;

  /** Submissions after this time are accepted but flagged `is_late`. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueAt?: Date;

  /** Up to 2 decimal places. Omit for ungraded work. */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(999999.99)
  maxMarks?: number;

  /** DRAFT (default, hidden from students), PUBLISHED (open), CLOSED (no more submissions). */
  @IsOptional()
  @IsIn(Object.values(assignments_status))
  status?: assignments_status;
}

export class UpdateAssignmentDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  instructions?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  attachmentAssetId?: number | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  dueAt?: Date | null;

  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(999999.99)
  maxMarks?: number | null;

  @IsOptional()
  @IsIn(Object.values(assignments_status))
  status?: assignments_status;
}

export class ListAssignmentsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  batchId: number;
}

export class SubmitAssignmentDto {
  /** Typed answer. Either responseText or assetId is required. */
  @AtLeastOneOf(['responseText', 'assetId'])
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  responseText?: string;

  /** A PRIVATE file you uploaded yourself via POST /files. */
  @IsOptional()
  @IsInt()
  @Min(1)
  assetId?: number;
}

export class ReviewSubmissionDto {
  /** Up to 2 decimal places, not above the assignment's maxMarks. */
  @IsOptional()
  @IsNumber(MARKS)
  @Min(0)
  @Max(999999.99)
  marksAwarded?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  feedback?: string;
}
