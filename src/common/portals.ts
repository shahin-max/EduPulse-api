import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ApiTags } from '@nestjs/swagger';
import {
  AuthenticatedRequest,
  IS_PUBLIC_KEY,
  isAdmin,
  Public,
} from './auth.js';

/**
 * Staged launch. `PORTALS_OPEN=admin` opens only the admin portal: faculty and students can
 * still sign in and manage their account, but every other signed-in route answers 403
 * PORTAL_CLOSED and the website shows them a "portal opening soon" page. Unset or `all`
 * opens everything. Nothing is removed; changing the setting and restarting reopens it.
 */
export type PortalsOpen = 'all' | 'admin';

export function portalsOpen(config: ConfigService): PortalsOpen {
  return config.get<string>('PORTALS_OPEN')?.trim().toLowerCase() === 'admin'
    ? 'admin'
    : 'all';
}

export const OPEN_BEFORE_LAUNCH_KEY = 'openBeforeLaunch';
/** Routes faculty and students may use while their portals are closed (sign-in, own account). */
export const OpenBeforeLaunch = () => SetMetadata(OPEN_BEFORE_LAUNCH_KEY, true);

/** Global guard; runs after JwtAuthGuard and RolesGuard. */
@Injectable()
export class PortalsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (portalsOpen(this.config) === 'all') return true;
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user || isAdmin(user)) return true;
    const open = this.reflector.getAllAndOverride<boolean>(
      OPEN_BEFORE_LAUNCH_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Public routes (the website) stay open to everyone, signed in or not.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (open || isPublic) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'PORTAL_CLOSED',
      message: 'Your portal is opening soon.',
    });
  }
}

@ApiTags('Health')
@Controller('portals')
export class PortalsController {
  constructor(private readonly config: ConfigService) {}

  /** Which portals are open, so the website can greet faculty and students accordingly. */
  @Public()
  @Get()
  status() {
    return { open: portalsOpen(this.config) };
  }
}
