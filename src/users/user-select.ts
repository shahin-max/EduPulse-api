import type { Prisma } from '../generated/prisma/client.js';
import type { RoleCode } from '../common/auth.js';
import { normalizeMobile } from '../common/validation.js';

/** User columns that are safe to return over the API (never password_hash). */
export const safeUserSelect = {
  id: true,
  public_id: true,
  full_name: true,
  email: true,
  mobile: true,
  status: true,
  email_verified_at: true,
  mobile_verified_at: true,
  last_login_at: true,
  created_at: true,
  updated_at: true,
  deleted_at: true,
  user_roles: { select: { roles: { select: { code: true } } } },
} satisfies Prisma.usersSelect;

export const userDetailSelect = {
  ...safeUserSelect,
  student_profiles: { omit: { user_id: true } },
  faculty_profiles: { omit: { user_id: true } },
} satisfies Prisma.usersSelect;

type WithRoleRows = { user_roles: { roles: { code: string } }[] };

/** Flattens user_roles into `roles: ["ADMIN", ...]` for API responses. */
export function withRoles<T extends WithRoleRows>({
  user_roles,
  ...user
}: T): Omit<T, 'user_roles'> & { roles: RoleCode[] } {
  return { ...user, roles: user_roles.map((ur) => ur.roles.code as RoleCode) };
}

export type SafeUser = ReturnType<
  typeof withRoles<Prisma.usersGetPayload<{ select: typeof safeUserSelect }>>
>;

/** Finds a user by email (contains "@") or by mobile (any common way of writing it). */
export function loginWhere(login: string): Prisma.usersWhereUniqueInput {
  return login.includes('@')
    ? { email: login.trim().toLowerCase() }
    : { mobile: normalizeMobile(login) };
}
