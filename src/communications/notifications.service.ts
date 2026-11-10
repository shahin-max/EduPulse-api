import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { paginated, skipTake } from '../common/pagination.js';
import { ListNotificationsQueryDto } from './dto/communications.dto.js';

export interface NotificationInput {
  title: string;
  message: string;
  linkUrl?: string | null;
}

/** In-app notifications. Exported so any module can notify users. */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return created;
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
