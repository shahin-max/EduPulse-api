import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AccessTokenPayload,
  AuthenticatedRequest,
  IS_PUBLIC_KEY,
  RoleCode,
} from '../auth.js';

/**
 * Global guard. Verifies the bearer access token, then loads its session, user and roles
 * in one query so that logout, suspension and role changes apply immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearer(request.headers.authorization);

    if (!token) {
      if (isPublic) return true;
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      if (payload.type !== 'access') throw new Error('wrong token type');
      const session = await this.prisma.auth_sessions.findUnique({
        where: { id: BigInt(payload.sid) },
        select: {
          user_id: true,
          revoked_at: true,
          expires_at: true,
          users: {
            select: {
              id: true,
              public_id: true,
              status: true,
              deleted_at: true,
              user_roles: { select: { roles: { select: { code: true } } } },
            },
          },
        },
      });
      const user = session?.users;
      if (
        !session ||
        !user ||
        session.revoked_at ||
        session.expires_at < new Date() ||
        String(session.user_id) !== payload.sub ||
        user.status !== 'ACTIVE' ||
        user.deleted_at
      ) {
        throw new Error('session ended');
      }
      request.user = {
        id: user.id,
        publicId: user.public_id,
        roles: user.user_roles.map((ur) => ur.roles.code as RoleCode),
        sessionId: BigInt(payload.sid),
      };
      return true;
    } catch {
      // A stale token on a public route should not block anonymous access.
      if (isPublic) return true;
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

export function extractBearer(header?: string): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value : undefined;
}
