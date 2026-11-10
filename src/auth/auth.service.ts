import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AccessTokenPayload,
  RefreshTokenPayload,
  RoleCode,
} from '../common/auth.js';
import {
  loginWhere,
  SafeUser,
  safeUserSelect,
  userDetailSelect,
  withRoles,
} from '../users/user-select.js';
import { PasswordService } from './password.service.js';
import { OneTimeTokenService, sha256 } from './one-time-token.service.js';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto/auth.dto.js';

export interface AuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** Access token lifetime as configured, e.g. "15m". */
  expiresIn: string;
  user: SafeUser;
}

const INVALID_CREDENTIALS = 'Invalid login or password';
const INVALID_REFRESH = 'Invalid or expired refresh token';

export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly passwords: PasswordService,
    private readonly tokens: OneTimeTokenService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthTokens> {
    const {
      fullName,
      email,
      mobile,
      password,
      dateOfBirth,
      grade,
      schoolName,
      guardianName,
      guardianMobile,
      address,
    } = dto;
    await this.assertContactFree(email, mobile);
    const user = await this.prisma.users.create({
      data: {
        public_id: randomUUID(),
        full_name: fullName,
        email,
        mobile,
        password_hash: await this.passwords.hash(password),
        status: 'ACTIVE',
        last_login_at: new Date(),
        user_roles: {
          create: [{ roles: { connect: { code: RoleCode.STUDENT } } }],
        },
        student_profiles: {
          create: {
            date_of_birth: dateOfBirth,
            grade,
            school_name: schoolName,
            guardian_name: guardianName,
            guardian_mobile: guardianMobile,
            address,
          },
        },
      },
      select: safeUserSelect,
    });
    return this.startSession(withRoles(user));
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.prisma.users.findUnique({
      where: loginWhere(dto.login),
    });
    if (
      !user ||
      user.deleted_at ||
      !(await this.passwords.verify(dto.password, user.password_hash))
    ) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    if (user.status === 'PENDING')
      throw new ForbiddenException(
        'Set your password using the link from the academy first',
      );
    if (user.status !== 'ACTIVE')
      throw new ForbiddenException(
        'This account has been suspended or disabled',
      );
    const updated = await this.prisma.users.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
      select: safeUserSelect,
    });
    return this.startSession(withRoles(updated));
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    if (payload.type !== 'refresh')
      throw new UnauthorizedException(INVALID_REFRESH);

    const sessionId = BigInt(payload.sid);
    const session = await this.prisma.auth_sessions.findUnique({
      where: { id: sessionId },
      include: { users: { select: safeUserSelect } },
    });
    if (
      !session ||
      String(session.user_id) !== payload.sub ||
      session.revoked_at ||
      session.expires_at < new Date()
    ) {
      throw new UnauthorizedException(INVALID_REFRESH);
    }
    const presentedHash = sha256(refreshToken);
    if (!sameHash(session.token_hash, presentedHash)) {
      // An already-rotated token was replayed: assume it was stolen and end this session.
      await this.prisma.auth_sessions.update({
        where: { id: sessionId },
        data: { revoked_at: new Date() },
      });
      throw new UnauthorizedException(
        'Refresh token reuse detected, please log in again',
      );
    }
    if (session.users.status !== 'ACTIVE' || session.users.deleted_at)
      throw new UnauthorizedException(INVALID_REFRESH);

    const tokens = await this.signTokens(withRoles(session.users), sessionId);
    // Conditional update: if two refreshes race with the same token, only one wins.
    const { count } = await this.prisma.auth_sessions.updateMany({
      where: { id: sessionId, token_hash: presentedHash, revoked_at: null },
      data: {
        token_hash: sha256(tokens.refreshToken),
        expires_at: this.expiryOf(tokens.refreshToken),
      },
    });
    if (count !== 1) throw new UnauthorizedException(INVALID_REFRESH);
    return tokens;
  }

  async logout(userId: bigint, sessionId: bigint): Promise<void> {
    await this.prisma.auth_sessions.updateMany({
      where: { id: sessionId, user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  async logoutAll(userId: bigint): Promise<void> {
    await revokeAllSessions(this.prisma, userId);
  }

  async me(userId: bigint) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: userDetailSelect,
    });
    if (!user) throw new NotFoundException('User not found');
    return withRoles(user);
  }

  /** Changes the password and signs out every other device. */
  async changePassword(
    userId: bigint,
    sessionId: bigint,
    dto: ChangePasswordDto,
  ): Promise<void> {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (
      !user ||
      !(await this.passwords.verify(dto.currentPassword, user.password_hash))
    ) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: { password_hash: await this.passwords.hash(dto.newPassword) },
      }),
      this.prisma.auth_sessions.updateMany({
        where: { user_id: userId, revoked_at: null, NOT: { id: sessionId } },
        data: { revoked_at: new Date() },
      }),
    ]);
  }

  /**
   * Always answers the same way, whether or not the account exists, so the endpoint
   * cannot be used to discover which emails or mobiles are registered.
   */
  async forgotPassword(
    login: string,
  ): Promise<{ message: string; devToken?: string }> {
    const message =
      'If an account exists for these details, a reset link has been sent.';
    const user = await this.prisma.users.findUnique({
      where: loginWhere(login),
    });
    if (
      !user ||
      user.deleted_at ||
      user.status === 'SUSPENDED' ||
      user.status === 'DISABLED'
    )
      return { message };
    const token = await this.tokens.issue(user.id, 'PASSWORD_RESET');
    return {
      message,
      ...this.tokens.deliver(
        'PASSWORD_RESET',
        (user.email ?? user.mobile)!,
        token,
      ),
    };
  }

  /** Sets a new password from a reset or invitation token, activates PENDING accounts and ends all sessions. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const userId = await this.tokens.consume(token, 'PASSWORD_RESET');
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (
      !user ||
      user.deleted_at ||
      user.status === 'SUSPENDED' ||
      user.status === 'DISABLED'
    ) {
      throw new BadRequestException(
        'This account cannot be reset; contact the academy',
      );
    }
    await this.prisma.$transaction([
      this.prisma.users.update({
        where: { id: userId },
        data: {
          password_hash: await this.passwords.hash(newPassword),
          status: 'ACTIVE',
        },
      }),
      this.prisma.auth_sessions.updateMany({
        where: { user_id: userId, revoked_at: null },
        data: { revoked_at: new Date() },
      }),
    ]);
  }

  async requestVerification(userId: bigint, channel: 'EMAIL' | 'MOBILE') {
    const user = await this.prisma.users.findUniqueOrThrow({
      where: { id: userId },
    });
    const destination = channel === 'EMAIL' ? user.email : user.mobile;
    if (!destination)
      throw new BadRequestException(
        `Add a${channel === 'EMAIL' ? 'n email' : ' mobile number'} to your account first`,
      );
    if (
      channel === 'EMAIL' ? user.email_verified_at : user.mobile_verified_at
    ) {
      throw new ConflictException(
        `Your ${channel === 'EMAIL' ? 'email' : 'mobile'} is already verified`,
      );
    }
    const purpose = channel === 'EMAIL' ? 'EMAIL_VERIFY' : 'MOBILE_VERIFY';
    const token = await this.tokens.issue(userId, purpose);
    return {
      message: 'Verification sent.',
      ...this.tokens.deliver(purpose, destination, token),
    };
  }

  /** Confirms a verification token. Works for whichever channel the token was issued for. */
  async confirmVerification(token: string) {
    const row = await this.prisma.auth_tokens.findUnique({
      where: { token_hash: sha256(token) },
      select: { purpose: true },
    });
    const purpose =
      row?.purpose === 'MOBILE_VERIFY' ? 'MOBILE_VERIFY' : 'EMAIL_VERIFY';
    const userId = await this.tokens.consume(token, purpose);
    const user = await this.prisma.users.update({
      where: { id: userId },
      data:
        purpose === 'EMAIL_VERIFY'
          ? { email_verified_at: new Date() }
          : { mobile_verified_at: new Date() },
      select: safeUserSelect,
    });
    return withRoles(user);
  }

  private async assertContactFree(
    email?: string,
    mobile?: string,
  ): Promise<void> {
    await assertContactFree(this.prisma, email, mobile);
  }

  private async startSession(user: SafeUser): Promise<AuthTokens> {
    // The session id is part of the token, so create the row first with a placeholder hash.
    const session = await this.prisma.auth_sessions.create({
      data: {
        user_id: user.id,
        token_hash: sha256(randomUUID()),
        expires_at: new Date(Date.now() + 60_000),
      },
    });
    const tokens = await this.signTokens(user, session.id);
    await this.prisma.auth_sessions.update({
      where: { id: session.id },
      data: {
        token_hash: sha256(tokens.refreshToken),
        expires_at: this.expiryOf(tokens.refreshToken),
      },
    });
    return tokens;
  }

  private async signTokens(
    user: SafeUser,
    sessionId: bigint,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL') ?? '15m';
    const refreshTtl = this.config.get<string>('JWT_REFRESH_TTL') ?? '7d';
    const sub = String(user.id);
    const sid = String(sessionId);
    const access: AccessTokenPayload = {
      sub,
      sid,
      roles: user.roles,
      type: 'access',
    };
    const refresh: RefreshTokenPayload = {
      sub,
      sid,
      jti: randomUUID(),
      type: 'refresh',
    };
    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(access, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: accessTtl as JwtSignOptions['expiresIn'],
      }),
      this.jwt.signAsync(refresh, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: refreshTtl as JwtSignOptions['expiresIn'],
      }),
    ]);
    return {
      tokenType: 'Bearer',
      accessToken,
      refreshToken,
      expiresIn: accessTtl,
      user,
    };
  }

  private expiryOf(token: string): Date {
    const { exp } = this.jwt.decode<{ exp: number }>(token);
    return new Date(exp * 1000);
  }
}

export async function revokeAllSessions(
  prisma: PrismaService,
  userId: bigint,
): Promise<void> {
  await prisma.auth_sessions.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
}

/** 409 when the email or mobile already belongs to another account. */
export async function assertContactFree(
  prisma: PrismaService,
  email?: string | null,
  mobile?: string | null,
  exceptId?: bigint,
) {
  const or = [...(email ? [{ email }] : []), ...(mobile ? [{ mobile }] : [])];
  if (!or.length) return;
  const existing = await prisma.users.findFirst({
    where: { OR: or, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
    select: { email: true },
  });
  if (existing) {
    throw new ConflictException(
      email && existing.email === email
        ? 'An account with this email already exists'
        : 'An account with this mobile already exists',
    );
  }
}
