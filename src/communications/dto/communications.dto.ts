import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import {
  announcements_audience,
  announcements_status,
} from '../../generated/prisma/enums.js';
import { PaginationQueryDto, toBoolean } from '../../common/pagination.js';
import { trim } from '../../common/validation.js';

export class CreateAnnouncementDto {
  /** @example "Holiday on Friday" */
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsString()
  @Length(1, 20000)
  body: string;

  /** ALL, ADMINS, FACULTY, STUDENTS or BATCH (faculty may only post to BATCH). */
  @IsIn(Object.values(announcements_audience))
  audience: announcements_audience;

  /** Required when audience is BATCH, and only then. */
  @IsOptional()
  @IsInt()
  @Min(1)
  batchId?: number;

  /** Optional scheduled time; it becomes visible (and notifies) from then on. */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publishAt?: Date;

  /** Publish immediately instead of saving a DRAFT. */
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class UpdateAnnouncementDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 20000)
  body?: string;

  @IsOptional()
  @IsIn(Object.values(announcements_audience))
  audience?: announcements_audience;

  /** null clears it (when moving away from BATCH). */
  @IsOptional()
  @IsInt()
  @Min(1)
  batchId?: number | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  publishAt?: Date | null;
}

export class ListAnnouncementsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(Object.values(announcements_status))
  status?: announcements_status;

  @IsOptional()
  @IsIn(Object.values(announcements_audience))
  audience?: announcements_audience;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;
}

export class FeedQueryDto extends PaginationQueryDto {
  /** Only announcements for this batch. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  batchId?: number;
}

export class ListNotificationsQueryDto extends PaginationQueryDto {
  /** Only unread notifications. */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unread?: boolean;
}

export class SendNotificationDto {
  @IsInt({ each: true })
  @Min(1, { each: true })
  userIds: number[];

  @Transform(trim)
  @IsString()
  @Length(2, 200)
  title: string;

  @IsString()
  @Length(1, 5000)
  message: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  linkUrl?: string;
}
