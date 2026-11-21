import {
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { html, Mailer } from '@nestjs/mail';
import { PrismaService } from '../prisma/prisma.service.js';
import { webUrl } from '../mail/mail.module.js';
import { paginated, skipTake } from '../common/pagination.js';
import { ListNotificationsQueryDto } from './dto/communications.dto.js';

export interface NotificationInput {
  title: string;
  message: string;
  linkUrl?: string | null;
  /**
   * Also email it to recipients who have an email address (fees, marks, results, new work,
   * announcements). Only with SMTP_URL set and EMAIL_NOTIFICATIONS not "false".
   */
  email?: boolean;
}

/** In-app notifications, optionally copied by email. Exported so any module can notify users. */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mailer?: Mailer,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Creates one notification per user (duplicates in `userIds` are ignored). Returns the count. */
  async notify(userIds: bigint[], input: NotificationInput): Promise<number> {
    const unique = [...new Set(userIds.map(String))].map((id) => BigInt(id));
    let created = 0;
    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000);
      const result = await this.prisma.notifications.createMany({
        data: chunk.map((user_id) => ({
          user_id,
          title: input.title.slice(0, 200),
          message: input.message,
          link_url: input.linkUrl ?? null,
        })),
      });
      created += result.count;
    }
    if (input.email && unique.length) this.emailCopies(unique, input);
    return created;
  }

  /** Whether notifications marked `email` are emailed: a real mail server is set up and not switched off. */
  get emailsOn(): boolean {
    if (!this.mailer || !this.config) return false;
    return (
      !!this.config.get<string>('SMTP_URL')?.trim() &&
      this.config.get<string>('EMAIL_NOTIFICATIONS')?.trim().toLowerCase() !==
        'false'
    );
  }

  /**
   * Emails the notification to the recipients with an address, in the background and one at a
   * time (the SMTP pool reuses connections). Failures are logged and never reach the caller.
   */
  private emailCopies(userIds: bigint[], input: NotificationInput): void {
    if (!this.emailsOn) return;
    const mailer = this.mailer!;
    const link = input.linkUrl
      ? `${webUrl(this.config!)}${input.linkUrl.startsWith('/') ? '' : '/'}${input.linkUrl}`
      : null;
    void (async () => {
      const users = await this.prisma.users.findMany({
        where: {
          id: { in: userIds },
          status: 'ACTIVE',
          deleted_at: null,
          email: { not: null },
        },
        select: { email: true, full_name: true },
      });
      let failed = 0;
      for (const user of users) {
        try {
          await mailer.send({
            to: user.email!,
            subject: input.title.slice(0, 200),
            html: html`<p>Hello ${user.full_name},</p>
              <p><strong>${input.title}</strong></p>
              <p>${input.message}</p>
              ${link ? html`<p><a href="${link}">Open in EduPulse</a></p>` : ''}
              <p style="color:#777;font-size:12px">
                EduPulse Academy. You get this email because it is about your
                account.
              </p>`,
          });
        } catch {
          failed += 1;
        }
      }
      if (failed)
        this.logger.warn(
          `${failed} of ${users.length} notification emails failed: ${input.title}`,
        );
    })().catch((error: unknown) =>
      this.logger.error(`Notification emails failed: ${String(error)}`),
    );
  }

  async listMine(userId: bigint, query: ListNotificationsQueryDto) {
    const where = {
      user_id: userId,
      ...(query.unread ? { read_at: null } : {}),
    };
    const [data, total, unread] = await this.prisma.$transaction([
      this.prisma.notifications.findMany({
        where,
        orderBy: { id: 'desc' },
        ...skipTake(query),
      }),
      this.prisma.notifications.count({ where }),
      this.prisma.notifications.count({
        where: { user_id: userId, read_at: null },
      }),
    ]);
    const page = paginated(data, total, query);
    return { ...page, meta: { ...page.meta, unread } };
  }

  async markRead(id: bigint, userId: bigint) {
    const notification = await this.prisma.notifications.findUnique({
      where: { id },
    });
    if (!notification || notification.user_id !== userId)
      throw new NotFoundException('Notification not found');
    if (notification.read_at) return notification;
    return this.prisma.notifications.update({
      where: { id },
      data: { read_at: new Date() },
    });
  }

  async markAllRead(userId: bigint): Promise<{ updated: number }> {
    const { count } = await this.prisma.notifications.updateMany({
      where: { user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    return { updated: count };
  }
}
