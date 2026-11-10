import type { Prisma } from '../generated/prisma/client.js';
import type { announcements_audience } from '../generated/prisma/enums.js';
import { RoleCode } from '../common/auth.js';

const ROLE_AUDIENCE: Record<RoleCode, announcements_audience> = {
  ADMIN: 'ADMINS',
  FACULTY: 'FACULTY',
  STUDENT: 'STUDENTS',
};

/**
 * Which announcements a user may read: ALL, the audiences of each of their roles, and
 * BATCH announcements for batches they can view ('all' for admins).
 */
export function audienceFilter(
  roles: RoleCode[],
  batchIds: bigint[] | 'all',
): Prisma.announcementsWhereInput[] {
  const filters: Prisma.announcementsWhereInput[] = [{ audience: 'ALL' }];
  const roleAudiences = [...new Set(roles.map((role) => ROLE_AUDIENCE[role]))];
  if (roleAudiences.length) filters.push({ audience: { in: roleAudiences } });
  if (batchIds === 'all') filters.push({ audience: 'BATCH' });
  else if (batchIds.length)
    filters.push({ audience: 'BATCH', batch_id: { in: batchIds } });
  return filters;
}

/** Same rule as audienceFilter, for one announcement already loaded. */
export function canSee(
  announcement: { audience: announcements_audience; batch_id: bigint | null },
  roles: RoleCode[],
  batchIds: bigint[] | 'all',
): boolean {
  if (announcement.audience === 'ALL') return true;
  if (announcement.audience === 'BATCH') {
    return (
      batchIds === 'all' ||
      (announcement.batch_id !== null &&
        batchIds.includes(announcement.batch_id))
    );
  }
  return roles.some((role) => ROLE_AUDIENCE[role] === announcement.audience);
}

/** Mirrors chk_announcement_batch: batch_id is set exactly when audience is BATCH. */
export function batchRuleError(
  audience: announcements_audience,
  batchId: bigint | null | undefined,
): string | null {
  if (audience === 'BATCH' && (batchId === null || batchId === undefined))
    return 'batchId is required when audience is BATCH';
  if (audience !== 'BATCH' && batchId !== null && batchId !== undefined)
    return 'batchId is only allowed when audience is BATCH';
  return null;
}

export const announcementLink = (id: bigint) => `/announcements/${id}`;
