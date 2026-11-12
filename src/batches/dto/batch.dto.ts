import { OmitType, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  batches_status,
  enrollments_status,
} from '../../generated/prisma/enums.js';
import { PaginationQueryDto, toBoolean } from '../../common/pagination.js';
import { CODE_REGEX, trim, upperTrim } from '../../common/validation.js';

export class CreateBatchDto {
  /** Branch that runs the batch. It cannot be changed later: enrollments, invoices and payments are tied to it. */
  @IsInt()
  @Min(1)
  branchId: number;

  @IsInt()
  @Min(1)
  courseId: number;

  /** Unique short code. @example "JEE-27-M1" */
  @Transform(upperTrim)
  @Matches(CODE_REGEX, { message: 'code may only contain A-Z, 0-9, - and _' })
  @Length(1, 50)
  code: string;

  /** @example "JEE 2027 Morning" */
  @Transform(trim)
  @IsString()
  @Length(2, 160)
  name: string;

  /** @example "2027-04-01" */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startDate?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date | null;

  /** Maximum PENDING + ACTIVE enrollments; omit for unlimited. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  capacity?: number | null;

  /** Defaults to PLANNED. */
  @IsOptional()
  @IsIn(Object.values(batches_status))
  status?: batches_status;
}

export class UpdateBatchDto extends PartialType(
  OmitType(CreateBatchDto, ['branchId'] as const),
) {}

export class ListBatchesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  courseId?: number;

  @IsOptional()
  @IsIn(Object.values(batches_status))
  status?: batches_status;

  /** Matches the batch name or code, or the course title or code. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  search?: string;

  /** Faculty: only batches you teach. Students: only batches you are enrolled in. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  mine?: boolean;
}

export class AssignFacultyDto {
  @IsInt()
  @Min(1)
  facultyUserId: number;

  /** Must be one of the course's subjects. */
  @IsInt()
  @Min(1)
  subjectId: number;
}

export class CreateEnrollmentDto {
  @IsInt()
  @Min(1)
  studentUserId: number;

  @IsInt()
  @Min(1)
  batchId: number;

  /** ACTIVE (default) or PENDING (e.g. awaiting first fee payment). */
  @IsOptional()
  @IsIn(['PENDING', 'ACTIVE'])
  status?: 'PENDING' | 'ACTIVE';

  /** Optional window for access to batch content. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  accessStartsAt?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  accessEndsAt?: Date;
}

export class UpdateEnrollmentDto {
  @IsOptional()
  @IsIn(Object.values(enrollments_status))
  status?: enrollments_status;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  accessStartsAt?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  accessEndsAt?: Date | null;
}

export class ListEnrollmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  studentUserId?: number;

  @IsOptional()
  @IsIn(Object.values(enrollments_status))
  status?: enrollments_status;
}
