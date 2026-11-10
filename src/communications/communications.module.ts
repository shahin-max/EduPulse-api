import { Module } from '@nestjs/common';
import {
  AnnouncementsController,
  NotificationsController,
} from './communications.controller.js';
import { AnnouncementsService } from './announcements.service.js';
import { NotificationsService } from './notifications.service.js';

/** Announcements and in-app notifications. NotificationsService is exported for other modules. */
@Module({
  controllers: [AnnouncementsController, NotificationsController],
  providers: [AnnouncementsService, NotificationsService],
  exports: [NotificationsService],
})
export class CommunicationsModule {}
