import { Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LocksModule, OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { AnnouncementsService } from '../communications/announcements.service.js';
import { ActivityNotifier } from '../communications/activity-notifier.service.js';
import { MysqlLockStore } from './mysql-lock-store.js';
import { jobsEnabled } from './jobs-config.js';

/**
 * Every minute, on one API instance at a time (MySQL lock, see MysqlLockStore), never overlapping
 * itself: send scheduled announcements that have become due, and "class at 5:30 pm" reminders for
 * classes starting within the hour. Both are idempotent, so a missed or repeated tick is harmless.
 */
@Injectable()
export class ScheduledJobs {
  private readonly logger = new Logger(ScheduledJobs.name);

  constructor(
    private readonly config: ConfigService,
    private readonly announcements: AnnouncementsService,
    private readonly activity: ActivityNotifier,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'announcements' })
  @OnOneInstance({ key: 'jobs:announcements' })
  @WithoutOverlapping({ key: 'jobs:announcements' })
  async dispatchAnnouncements(): Promise<void> {
    if (!jobsEnabled(this.config)) return;
    const sent = await this.announcements.dispatchDue();
    if (sent) this.logger.log(`Scheduled announcements: ${sent} notifications`);
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'class-reminders' })
  @OnOneInstance({ key: 'jobs:class-reminders' })
  @WithoutOverlapping({ key: 'jobs:class-reminders' })
  async remindClasses(): Promise<void> {
    if (!jobsEnabled(this.config)) return;
    await this.activity.remindUpcomingClasses();
  }
}

/** Scheduled jobs and their locks. ScheduleModule.forRoot() is registered once, in AppModule. */
@Module({
  imports: [LocksModule.forRoot()],
  providers: [MysqlLockStore, ScheduledJobs],
})
export class JobsModule {}
