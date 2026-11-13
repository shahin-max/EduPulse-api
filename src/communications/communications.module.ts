import { Global, Module } from '@nestjs/common';
import {
  AnnouncementsController,
  NotificationsController,
} from './communications.controller.js';
import { AnnouncementsService } from './announcements.service.js';
import { NotificationsService } from './notifications.service.js';
import { ActivityNotifier } from './activity-notifier.service.js';

/**
 * Announcements and in-app notifications. Global, so any module can inject NotificationsService or
 * ActivityNotifier (event notifications such as new assignments and confirmed payments).
 */
@Global()
@Module({
  controllers: [AnnouncementsController, NotificationsController],
  providers: [AnnouncementsService, NotificationsService, ActivityNotifier],
  exports: [NotificationsService, ActivityNotifier],
})
export class CommunicationsModule {}
