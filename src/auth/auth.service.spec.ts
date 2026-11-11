import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Mailer } from '@nestjs/mail';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService, sameHash } from './auth.service.js';
import { OneTimeTokenService, sha256 } from './one-time-token.service.js';
import type { PasswordService } from './password.service.js';
import { safeUserSelect } from '../users/user-select.js';

const env: Record<string, string> = {
  JWT_ACCESS_SECRET: 'unit-access-secret-0123456789abcdefghij',
  JWT_REFRESH_SECRET: 'unit-refresh-secret-0123456789abcdefghi',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
};
const config = {
  get: (k: string) => env[k],
  getOrThrow: (k: string) => env[k],
} as unknown as ConfigService;

const dbUser = {
  id: 1n,
  public_id: 'uuid-1',
  full_name: 'Aman Khan',
  email: 'aman@example.com',
  mobile: '+919876543210',
  status: 'ACTIVE',
  deleted_at: null,
  password_hash: 'hashed:Secret123',
  user_roles: [{ roles: { code: 'STUDENT' } }],
};

function setup() {
  const prisma = {
    users: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    auth_sessions: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    auth_tokens: { findUnique: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const passwords = {
    hash: vi.fn(async (p: string) => `hashed:${p}`),
    verify: vi.fn(async (p: string, h: string | null) => h === `hashed:${p}`),
  };
  const jwt = new JwtService();
  const tokens = new OneTimeTokenService(
    prisma as unknown as PrismaService,
    config,
    { send: vi.fn().mockResolvedValue({}) } as unknown as Mailer,
  );
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    config,
    passwords as unknown as PasswordService,
    tokens,
  );
  prisma.auth_sessions.create.mockResolvedValue({ id: 99n });
  return { prisma, jwt, service };
}

describe('AuthService.login', () => {
  it('opens a session whose id is in both tokens, storing only the refresh hash', async () => {
    const { prisma, jwt, service } = setup();
    const { password_hash: _hash, ...safeRow } = dbUser;
    prisma.users.findUnique.mockResolvedValue(dbUser);
    prisma.users.update.mockResolvedValue(safeRow);

    const result = await service.login({
      login: '98765 43210',
      password: 'Secret123',
    });

    expect(prisma.users.findUnique).toHaveBeenCalledWith({
      where: { mobile: '+919876543210' },
    });
    // The returned user comes from a select that never includes password_hash.
    expect(prisma.users.update.mock.calls[0][0].select).toEqual(safeUserSelect);
    expect(safeUserSelect).not.toHaveProperty('password_hash');
    const access = jwt.verify(result.accessToken, {
      secret: env.JWT_ACCESS_SECRET,
    });
    const refresh = jwt.verify(result.refreshToken, {
      secret: env.JWT_REFRESH_SECRET,
    });
    expect(access).toMatchObject({
      sub: '1',
      sid: '99',
      roles: ['STUDENT'],
      type: 'access',
    });
    expect(refresh).toMatchObject({ sub: '1', sid: '99', type: 'refresh' });
    expect(prisma.auth_sessions.update.mock.calls[0][0].data.token_hash).toBe(
      sha256(result.refreshToken),
    );
    expect(result.user).toMatchObject({ id: 1n, roles: ['STUDENT'] });
    expect(result.user).not.toHaveProperty('password_hash');
  });

  it.each([
    ['unknown login', null],
    ['soft-deleted user', { ...dbUser, deleted_at: new Date() }],
    ['user without a password (invited)', { ...dbUser, password_hash: null }],
  ])('answers 401 with one message for %s', async (_label, row) => {
    const { prisma, service } = setup();
    prisma.users.findUnique.mockResolvedValue(row);
    await expect(
      service.login({ login: 'aman@example.com', password: 'Secret123' }),
    ).rejects.toThrow(new UnauthorizedException('Invalid login or password'));
  });

  it('blocks suspended accounts after a correct password', async () => {
    const { prisma, service } = setup();
    prisma.users.findUnique.mockResolvedValue({
      ...dbUser,
      status: 'SUSPENDED',
    });
    await expect(
      service.login({ login: 'aman@example.com', password: 'Secret123' }),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe('AuthService.refresh', () => {
  async function loggedIn() {
    const ctx = setup();
    ctx.prisma.users.findUnique.mockResolvedValue(dbUser);
    ctx.prisma.users.update.mockResolvedValue(dbUser);
    const tokens = await ctx.service.login({
      login: 'aman@example.com',
      password: 'Secret123',
    });
    const session = {
      id: 99n,
      user_id: 1n,
      token_hash: sha256(tokens.refreshToken),
      revoked_at: null,
      expires_at: new Date(Date.now() + 86_400_000),
      users: dbUser,
    };
    return { ...ctx, tokens, session };
  }

  it('rotates the token with a conditional update on the old hash', async () => {
    const { service, prisma, tokens, session } = await loggedIn();
    prisma.auth_sessions.findUnique.mockResolvedValue(session);
    prisma.auth_sessions.updateMany.mockResolvedValue({ count: 1 });
    const next = await service.refresh(tokens.refreshToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    const call = prisma.auth_sessions.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      id: 99n,
      token_hash: sha256(tokens.refreshToken),
      revoked_at: null,
    });
    expect(call.data.token_hash).toBe(sha256(next.refreshToken));
  });

  it('revokes the session when a rotated token is replayed', async () => {
    const { service, prisma, tokens, session } = await loggedIn();
    prisma.auth_sessions.findUnique.mockResolvedValue({
      ...session,
      token_hash: sha256('newer'),
    });
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow(
      /reuse detected/,
    );
    expect(prisma.auth_sessions.update).toHaveBeenLastCalledWith({
      where: { id: 99n },
      data: { revoked_at: expect.any(Date) },
    });
  });

  it('loses a race against a concurrent refresh', async () => {
    const { service, prisma, tokens, session } = await loggedIn();
    prisma.auth_sessions.findUnique.mockResolvedValue(session);
    prisma.auth_sessions.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects access tokens and sessions of suspended users', async () => {
    const { service, prisma, tokens, session } = await loggedIn();
    await expect(service.refresh(tokens.accessToken)).rejects.toThrow(
      UnauthorizedException,
    );
    prisma.auth_sessions.findUnique.mockResolvedValue({
      ...session,
      users: { ...dbUser, status: 'SUSPENDED' },
    });
    await expect(service.refresh(tokens.refreshToken)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('OneTimeTokenService', () => {
  it('rejects used, expired or wrong-purpose tokens', async () => {
    const { prisma } = setup();
    const tokens = new OneTimeTokenService(
      prisma as unknown as PrismaService,
      config,
      { send: vi.fn().mockResolvedValue({}) } as unknown as Mailer,
    );
    const base = {
      id: 5n,
      user_id: 1n,
      purpose: 'PASSWORD_RESET',
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
    };
    for (const row of [
      null,
      { ...base, used_at: new Date() },
      { ...base, expires_at: new Date(Date.now() - 1) },
      { ...base, purpose: 'EMAIL_VERIFY' },
    ]) {
      prisma.auth_tokens.findUnique.mockResolvedValueOnce(row);
      await expect(
        tokens.consume('t'.repeat(64), 'PASSWORD_RESET'),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('only exposes tokens when EXPOSE_DEV_TOKENS=true outside production', () => {
    const { prisma } = setup();
    const make = (vars: Record<string, string>) =>
      new OneTimeTokenService(
        prisma as unknown as PrismaService,
        { get: (k: string) => vars[k] } as unknown as ConfigService,
        { send: vi.fn().mockResolvedValue({}) } as unknown as Mailer,
      );
    expect(
      make({ EXPOSE_DEV_TOKENS: 'true' }).deliver(
        'PASSWORD_RESET',
        'a@b.c',
        'tok',
      ),
    ).toEqual({ devToken: 'tok' });
    expect(
      make({ EXPOSE_DEV_TOKENS: 'true', NODE_ENV: 'production' }).deliver(
        'PASSWORD_RESET',
        'a@b.c',
        'tok',
      ),
    ).toEqual({});
    expect(make({}).deliver('PASSWORD_RESET', 'a@b.c', 'tok')).toEqual({});
  });

  it('emails reset and verification links, and never emails mobile numbers', () => {
    const { prisma } = setup();
    const send = vi.fn().mockResolvedValue({});
    const vars: Record<string, string> = {
      APP_WEB_URL: 'https://edupulse.example/',
    };
    const tokens = new OneTimeTokenService(
      prisma as unknown as PrismaService,
      { get: (k: string) => vars[k] } as unknown as ConfigService,
      { send } as unknown as Mailer,
    );
    tokens.deliver('PASSWORD_RESET', 'a@b.c', 'abc123');
    expect(send).toHaveBeenCalledTimes(1);
    const reset = send.mock.calls[0][0];
    expect(reset.to).toBe('a@b.c');
    expect(String(reset.html)).toContain(
      'https://edupulse.example/set-password?token=abc123',
    );
    tokens.deliver('EMAIL_VERIFY', 'a@b.c', 'def456');
    expect(String(send.mock.calls[1][0].html)).toContain(
      'https://edupulse.example/verify-email?token=def456',
    );
    tokens.deliver('PASSWORD_RESET', '+919876543210', 'tok');
    tokens.deliver('MOBILE_VERIFY', '+919876543210', 'tok');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('sameHash', () => {
  it('compares hex digests in constant time and handles bad input', () => {
    expect(sameHash(sha256('a'), sha256('a'))).toBe(true);
    expect(sameHash(sha256('a'), sha256('b'))).toBe(false);
    expect(sameHash(sha256('a'), 'short')).toBe(false);
  });
});
