import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { courses_status } from '../../generated/prisma/enums.js';
import { toBoolean } from '../../common/pagination.js';
import {
  CODE_REGEX,
  lowerTrim,
  SLUG_REGEX,
  trim,
  upperTrim,
} from '../../common/validation.js';

export class CreateSubjectDto {
  /** @example "PHY" */
  @Transform(upperTrim)
  @Matches(CODE_REGEX, { message: 'code may only contain A-Z, 0-9, - and _' })
  @Length(1, 50)
  code: string;

  /** @example "Physics" */
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  name: string;
}

export class UpdateSubjectDto extends PartialType(CreateSubjectDto) {}

export class CreateCourseDto {
  /** @example "JEE" */
  @Transform(upperTrim)
  @Matches(CODE_REGEX, { message: 'code may only contain A-Z, 0-9, - and _' })
  @Length(1, 40)
  code: string;

  /** @example "jee" */
  @Transform(lowerTrim)
  @Matches(SLUG_REGEX, {
    message:
      'slug may only contain lowercase letters, digits and single hyphens',
  })
  @Length(2, 160)
  slug: string;

  /** @example "JEE Main & Advanced" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  /** A PUBLIC file asset used as the course image. */
  @IsOptional()
  @IsInt()
  @Min(1)
  thumbnailAssetId?: number | null;

  /** Only PUBLISHED courses appear on the website. Defaults to DRAFT. */
  @IsOptional()
  @IsIn(Object.values(courses_status))
  status?: courses_status;

  /** Lower numbers are listed first. */
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateCourseDto extends PartialType(CreateCourseDto) {}

export class ListCoursesQueryDto {
  /** Staff only: include DRAFT and ARCHIVED courses. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  includeAll?: boolean;
}

export class AttachSubjectDto {
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class CreateChapterDto {
  @IsInt()
  @Min(1)
  courseId: number;

  @IsInt()
  @Min(1)
  subjectId: number;

  /** @example "Laws of Motion" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  /** Unpublished chapters are only visible to admins and faculty. */
  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateChapterDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20000)
  description?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}
