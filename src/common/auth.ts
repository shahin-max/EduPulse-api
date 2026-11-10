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

/** The authenticated user attached to `request.user` by JwtAuthGuard. */
export interface AuthUser {
  id: bigint;
  publicId: string;
  /** A user can hold several roles (user_roles table). */
  roles: RoleCode[];
  /** auth_sessions.id of the device this access token belongs to. */
  sessionId: bigint;
}

export interface AccessTokenPayload {
  /** users.id as a string (JWT claims cannot hold BigInt). */
  sub: string;
  sid: string;
  roles: RoleCode[];
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
export const Roles = (...roles: RoleCode[]) => SetMetadata(ROLES_KEY, roles);

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

export const isAdmin = (user?: AuthUser): boolean =>
  hasRole(user, RoleCode.ADMIN);
/** Admins and faculty: people who run the academy, as opposed to students and visitors. */
export const isStaff = (user?: AuthUser): boolean =>
  hasRole(user, RoleCode.ADMIN, RoleCode.FACULTY);
