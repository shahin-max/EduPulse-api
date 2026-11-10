import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  class_attendance_status,
  class_sessions_status,
} from '../../generated/prisma/enums.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../common/validation.js';

const URL_OPTIONS = { require_protocol: true, protocols: ['http', 'https'] };

export class CreateClassSessionDto {
  @IsInt()
  @Min(1)
  batchId: number;

  /** Must be one of the batch's course subjects. */
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number;

  /** Faculty teaching the class; must be assigned to the batch. Defaults to the creating faculty member. */
  @IsOptional()
  @IsInt()
  @Min(1)
  facultyUserId?: number;

  /** @example "Kinematics - problem session" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  /** @example "2027-04-05T07:00:00+05:30" */
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  /** Must be after startsAt. @example "2027-04-05T09:00:00+05:30" */
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  /** Online class link. */
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  meetingUrl?: string;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  recordingUrl?: string;
}

export class UpdateClassSessionDto {
  /** null removes the subject. */
  @IsOptional()
  @IsInt()
  @Min(1)
  subjectId?: number | null;

  /** null removes the faculty member. */
  @IsOptional()
  @IsInt()
  @Min(1)
  facultyUserId?: number | null;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startsAt?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endsAt?: Date;

  @IsOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  meetingUrl?: string | null;

  /** Add the recording after the class. */
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  @MaxLength(2048)
  recordingUrl?: string | null;

  /** SCHEDULED, COMPLETED or CANCELLED. */
  @IsOptional()
  @IsIn(Object.values(class_sessions_status))
  status?: class_sessions_status;
}

export class ListClassSessionsQueryDto extends PaginationQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  batchId: number;

  /** Sessions starting at or after this time. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Sessions starting before this time. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsIn(Object.values(class_sessions_status))
  status?: class_sessions_status;
}

export class TimetableQueryDto {
  /** Defaults to now. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  /** Defaults to 7 days after `from`; at most 31 days after it. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

export class AttendanceEntryDto {
  @IsInt()
  @Min(1)
  enrollmentId: number;

  /** PRESENT, ABSENT, LATE or EXCUSED. */
  @IsIn(Object.values(class_attendance_status))
  status: class_attendance_status;
}

export class MarkAttendanceDto {
  /** One entry per student; existing marks for these enrollments are overwritten. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => AttendanceEntryDto)
  entries: AttendanceEntryDto[];
}
