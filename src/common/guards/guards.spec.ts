import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedRequest, AuthUser } from '../auth.js';
import { extractBearer, JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';

const SECRET = 'unit-test-access-secret-0123456789abcdef';

function contextFor(request: object): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const user = (roles: string[]) => ({
    user: { id: 1n, roles } as unknown as AuthUser,
  });

  afterEach(() => vi.restoreAllMocks());

  it('allows any request when the route declares no roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it('allows a user holding any one of the listed roles', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['ADMIN']);
    expect(guard.canActivate(contextFor(user(['FACULTY', 'ADMIN'])))).toBe(
      true,
    );
  });

  it('rejects users without a listed role, and anonymous requests', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue([
      'ADMIN',
      'FACULTY',
    ]);
    expect(() => guard.canActivate(contextFor(user(['STUDENT'])))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });
});

describe('JwtAuthGuard', () => {
  const jwt = new JwtService();
  const reflector = new Reflector();
  const findUnique = vi.fn();
  const prisma = { auth_sessions: { findUnique } } as unknown as PrismaService;
  const config = { getOrThrow: () => SECRET } as unknown as ConfigService;
  const guard = new JwtAuthGuard(reflector, jwt, config, prisma);

  const liveSession = {
    user_id: 7n,
    revoked_at: null,
    expires_at: new Date(Date.now() + 60_000),
    users: {
      id: 7n,
      public_id: 'uuid-7',
      status: 'ACTIVE',
      deleted_at: null,
      user_roles: [
        { roles: { code: 'FACULTY' } },
        { roles: { code: 'ADMIN' } },
      ],
    },
  };
  const token = (
    payload: object = {
      sub: '7',
      sid: '42',
      roles: ['STUDENT'],
      type: 'access',
    },
    secret = SECRET,
  ) => jwt.signAsync(payload, { secret, expiresIn: '5m' });

  async function run(isPublic: boolean, authorization?: string) {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(isPublic);
    const request = { headers: { authorization } } as AuthenticatedRequest;
    return { request, result: guard.canActivate(contextFor(request)) };
  }

  beforeEach(() => findUnique.mockReset());

  it('attaches the user with roles read from the database, not from the token', async () => {
    findUnique.mockResolvedValue(liveSession);
    const { request, result } = await run(false, `Bearer ${await token()}`);
    await expect(result).resolves.toBe(true);
    expect(request.user).toEqual({
      id: 7n,
      publicId: 'uuid-7',
      roles: ['FACULTY', 'ADMIN'],
      sessionId: 42n,
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 42n } }),
    );
  });

  it.each([
    ['a revoked session', { ...liveSession, revoked_at: new Date() }],
    [
      'an expired session',
      { ...liveSession, expires_at: new Date(Date.now() - 1000) },
    ],
    [
      'a suspended user',
      { ...liveSession, users: { ...liveSession.users, status: 'SUSPENDED' } },
    ],
    [
      'a PENDING user',
      { ...liveSession, users: { ...liveSession.users, status: 'PENDING' } },
    ],
    [
      'a soft-deleted user',
      {
        ...liveSession,
        users: { ...liveSession.users, deleted_at: new Date() },
      },
    ],
    ['a session of another user', { ...liveSession, user_id: 8n }],
    ['a missing session', null],
  ])('rejects %s', async (_label, session) => {
    findUnique.mockResolvedValue(session);
    await expect(
      (await run(false, `Bearer ${await token()}`)).result,
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects refresh tokens and tokens signed with another key', async () => {
    findUnique.mockResolvedValue(liveSession);
    const refresh = await token({
      sub: '7',
      sid: '42',
      jti: 'x',
      type: 'refresh',
    });
    await expect(
      (await run(false, `Bearer ${refresh}`)).result,
    ).rejects.toThrow(UnauthorizedException);
    const forged = await token(
      undefined,
      'another-secret-0123456789abcdefghijk',
    );
    await expect((await run(false, `Bearer ${forged}`)).result).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('lets public routes through anonymously, even with a bad token', async () => {
    await expect((await run(true)).result).resolves.toBe(true);
    const { request, result } = await run(true, 'Bearer junk');
    await expect(result).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('extracts bearer tokens case-insensitively', () => {
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
  });
});
