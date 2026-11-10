import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { RoleCode, Roles } from '../common/auth.js';
import {
  PaginationQueryDto,
  paginated,
  skipTake,
} from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  actorUserId?: number;

  /** e.g. "Users", "Batches" */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityId?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Who changed what, newest first. Admin only. */
  @Roles(RoleCode.ADMIN)
  @Get()
  async findAll(@Query() query: ListAuditLogsQueryDto) {
    const where: Prisma.audit_logsWhereInput = {
      actor_user_id:
        query.actorUserId === undefined ? undefined : BigInt(query.actorUserId),
      entity_type: query.entityType,
      entity_id: query.entityId,
      created_at:
        query.from || query.to ? { gte: query.from, lte: query.to } : undefined,
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.audit_logs.findMany({
        where,
        include: { users: { select: { id: true, full_name: true } } },
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.audit_logs.count({ where }),
    ]);
    return paginated(data, total, query);
  }
}

@Module({ controllers: [AuditLogsController] })
export class AuditModule {}
