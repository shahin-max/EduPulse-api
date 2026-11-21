import type { Prisma } from '../generated/prisma/client.js';
import type { announcements_audience } from '../generated/prisma/enums.js';
import { RoleCode } from '../common/auth.js';

const ROLE_AUDIENCE: Record<RoleCode, announcements_audience> = {
  ADMIN: 'ADMINS',
  FACULTY: 'FACULTY',
  STUDENT: 'STUDENTS',
};

/** Audiences a user's roles reach. Branch admins read ADMINS announcements like head office. */
function roleAudiences(
  roles: RoleCode[],
  branchAdmin: boolean,
): announcements_audience[] {
  const audiences = new Set(roles.map((role) => ROLE_AUDIENCE[role]));
  if (branchAdmin) audiences.add('ADMINS');
  return [...audiences];
}

/**
 * Which announcements a user may read: ALL, the audiences of each of their roles, BATCH
 * announcements for batches they can view and BRANCH announcements for branches they belong to
 * ('all' for head office).
 */
export function audienceFilter(
  roles: RoleCode[],
  batchIds: bigint[] | 'all',
  branchIds: bigint[] | 'all' = [],
  branchAdmin = false,
): Prisma.announcementsWhereInput[] {
  const filters: Prisma.announcementsWhereInput[] = [{ audience: 'ALL' }];
  const audiences = roleAudiences(roles, branchAdmin);
  if (audiences.length) filters.push({ audience: { in: audiences } });
  if (batchIds === 'all') filters.push({ audience: 'BATCH' });
  else if (batchIds.length)
    filters.push({ audience: 'BATCH', batch_id: { in: batchIds } });
  if (branchIds === 'all') filters.push({ audience: 'BRANCH' });
  else if (branchIds.length)
    filters.push({ audience: 'BRANCH', branch_id: { in: branchIds } });
  return filters;
}

/** Same rule as audienceFilter, for one announcement already loaded. */
export function canSee(
  announcement: {
    audience: announcements_audience;
    batch_id: bigint | null;
    branch_id?: bigint | null;
  },
  roles: RoleCode[],
  batchIds: bigint[] | 'all',
  branchIds: bigint[] | 'all' = [],
  branchAdmin = false,
): boolean {
  if (announcement.audience === 'ALL') return true;
  if (announcement.audience === 'BATCH') {
    return (
      batchIds === 'all' ||
      (announcement.batch_id !== null &&
        batchIds.includes(announcement.batch_id))
    );
  }
  if (announcement.audience === 'BRANCH') {
    const branchId = announcement.branch_id ?? null;
    return (
      branchIds === 'all' || (branchId !== null && branchIds.includes(branchId))
    );
  }
  return roleAudiences(roles, branchAdmin).includes(announcement.audience);
}

/**
 * Mirrors chk_announcement_batch and chk_announcement_branch: batch_id is set exactly when the
 * audience is BATCH, branch_id exactly when it is BRANCH.
 */
export function batchRuleError(
  audience: announcements_audience,
  batchId: bigint | null | undefined,
  branchId?: bigint | null,
): string | null {
  if (audience === 'BATCH' && (batchId === null || batchId === undefined))
    return 'batchId is required when audience is BATCH';
  if (audience !== 'BATCH' && batchId !== null && batchId !== undefined)
    return 'batchId is only allowed when audience is BATCH';
  if (audience === 'BRANCH' && (branchId === null || branchId === undefined))
    return 'branchId is required when audience is BRANCH';
  if (audience !== 'BRANCH' && branchId !== null && branchId !== undefined)
    return 'branchId is only allowed when audience is BRANCH';
  return null;
}

export const announcementLink = (id: bigint) => `/announcements/${id}`;
