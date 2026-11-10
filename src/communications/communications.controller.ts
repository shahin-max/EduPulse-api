import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth.js';
import { CurrentUser, RoleCode, Roles, SkipAudit } from '../common/auth.js';
import { AnnouncementsService } from './announcements.service.js';
import { NotificationsService } from './notifications.service.js';
import {
  CreateAnnouncementDto,
  FeedQueryDto,
  ListAnnouncementsQueryDto,
  ListNotificationsQueryDto,
  SendNotificationDto,
  UpdateAnnouncementDto,
} from './dto/communications.dto.js';

@ApiTags('Announcements')
@ApiBearerAuth()
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  /** Create a draft, or publish straight away with publish=true. Faculty may only post to their batches. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post()
  create(@Body() dto: CreateAnnouncementDto, @CurrentUser() user: AuthUser) {
    return this.announcements.create(dto, user);
  }

  /** Manage announcements: admins see all, faculty see their own. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Get()
  list(
    @Query() query: ListAnnouncementsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.announcements.list(query, user);
  }

  /** Announcements addressed to you (by role and batch), newest first. Any logged-in user. */
  @Get('feed')
  async feed(@Query() query: FeedQueryDto, @CurrentUser() user: AuthUser) {
    await this.announcements.dispatchDueLazily();
    return this.announcements.feed(query, user);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.announcements.findOne(BigInt(id), user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateAnnouncementDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.announcements.update(BigInt(id), dto, user);
  }

  /** Publish now, or at publish_at if that is in the future. Notifies the audience once it is due. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post(':id/publish')
  publish(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.announcements.publish(BigInt(id), user);
  }

  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @Post(':id/archive')
  archive(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.announcements.archive(BigInt(id), user);
  }

  /** Admins delete any announcement; authors delete their drafts. */
  @Roles(RoleCode.ADMIN, RoleCode.FACULTY)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.announcements.remove(BigInt(id), user);
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly announcements: AnnouncementsService,
  ) {}

  /** Your notifications, newest first; meta.unread is your unread count. */
  @Get()
  async list(
    @Query() query: ListNotificationsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    await this.announcements.dispatchDueLazily();
    return this.notifications.listMine(user.id, query);
  }

  @SkipAudit()
  @Post('read-all')
  readAll(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(user.id);
  }

  @SkipAudit()
  @Patch(':id/read')
  read(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.notifications.markRead(BigInt(id), user.id);
  }

  /** Send a direct notification to specific users. Admin only. */
  @Roles(RoleCode.ADMIN)
  @Post()
  async send(@Body() dto: SendNotificationDto) {
    const created = await this.notifications.notify(
      dto.userIds.map((id) => BigInt(id)),
      { title: dto.title, message: dto.message, linkUrl: dto.linkUrl },
    );
    return { created };
  }
}
