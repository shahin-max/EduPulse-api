import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';

/** Codes of the rows in the `roles` table (seeded by the baseline migration). */
export const RoleCode = {
  ADMIN: 'ADMIN',
  FACULTY: 'FACULTY',
  STUDENT: 'STUDENT',
} as const;
export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];
export const ALL_ROLES = Object.values(RoleCode);

/**
 * Not a row in `roles`: a user is a branch admin when `branch_staff` gives them ADMIN at one or
 * more active branches and they do not hold the global ADMIN role (the super admin). Routes opt
 * in with `@Roles(RoleCode.ADMIN, BRANCH_ADMIN)` and then limit the data to those branches.
 */
export const BRANCH_ADMIN = 'BRANCH_ADMIN' as const;
export type AccessRole = RoleCode | typeof BRANCH_ADMIN;

/** The authenticated user attached to `request.user` by JwtAuthGuard. */
export interface AuthUser {
  id: bigint;
  publicId: string;
  /** A user can hold several roles (user_roles table). */
  roles: RoleCode[];
  /** auth_sessions.id of the device this access token belongs to. */
  sessionId: bigint;
  /** Active branches where branch_staff makes the user ADMIN. Empty for super admins. */
  adminBranchIds?: bigint[];
}

export interface AccessTokenPayload {
  /** users.id as a string (JWT claims cannot hold BigInt). */
  sub: string;
  sid: string;
  /** Informational only: every request re-reads roles from the database. */
  roles: AccessRole[];
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  sid: string;
  /** Random per token, so two tokens issued in the same second still differ. */
  jti: string;
  type: 'refresh';
}

export type AuthenticatedRequest = Request & { user?: AuthUser };

export const IS_PUBLIC_KEY = 'isPublic';
/** Route needs no token. A valid token is still read, so handlers can tailor output to staff. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route to users holding at least one of the listed roles. */
export const Roles = (...roles: AccessRole[]) => SetMetadata(ROLES_KEY, roles);

export const SKIP_AUDIT_KEY = 'skipAudit';
/** Excludes a high-volume mutating route (e.g. saving an exam answer) from the audit log. */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

export function hasRole(
  user: AuthUser | undefined,
  ...roles: RoleCode[]
): boolean {
  return !!user && user.roles.some((role) => roles.includes(role));
}

/** Whether the user holds one of the roles, counting BRANCH_ADMIN (see isBranchAdmin). */
export function hasAccessRole(
  user: AuthUser | undefined,
  ...roles: AccessRole[]
): boolean {
  if (!user) return false;
  return roles.some((role) =>
    role === BRANCH_ADMIN ? isBranchAdmin(user) : user.roles.includes(role),
  );
}

/** The super admin (global ADMIN role): every branch and the shared catalog, website and settings. */
export const isAdmin = (user?: AuthUser): boolean =>
  hasRole(user, RoleCode.ADMIN);
/** Admin of one or more branches only (not a super admin). */
export const isBranchAdmin = (user?: AuthUser): boolean =>
  !!user && !isAdmin(user) && (user.adminBranchIds?.length ?? 0) > 0;
/** Super admin or branch admin: someone who uses the admin portal. */
export const isAnyAdmin = (user?: AuthUser): boolean =>
  isAdmin(user) || isBranchAdmin(user);
/** Admins and faculty: people who run the academy, as opposed to students and visitors. */
export const isStaff = (user?: AuthUser): boolean =>
  hasRole(user, RoleCode.ADMIN, RoleCode.FACULTY) || isBranchAdmin(user);
