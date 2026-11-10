import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { auth_tokens_purpose } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type TokenPurpose = auth_tokens_purpose;

const LIFETIME_MS: Record<TokenPurpose, number> = {
  PASSWORD_RESET: 60 * 60 * 1000,
  EMAIL_VERIFY: 24 * 60 * 60 * 1000,
  MOBILE_VERIFY: 24 * 60 * 60 * 1000,
};

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Single-use tokens for password reset and email/mobile verification (auth_tokens table).
 * Only the SHA-256 is stored. Issuing a token invalidates earlier unused ones of the same purpose.
 */
@Injectable()
export class OneTimeTokenService {
  private readonly logger = new Logger(OneTimeTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async issue(userId: bigint, purpose: TokenPurpose): Promise<string> {
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.auth_tokens.updateMany({
        where: { user_id: userId, purpose, used_at: null },
        data: { used_at: now },
      }),
      this.prisma.auth_tokens.create({
        data: {
          user_id: userId,
          purpose,
          token_hash: sha256(token),
          expires_at: new Date(now.getTime() + LIFETIME_MS[purpose]),
        },
      }),
    ]);
    return token;
  }

  /** Marks the token used and returns its user id. Throws 400 if unknown, used, expired or of another purpose. */
  async consume(token: string, purpose: TokenPurpose): Promise<bigint> {
    const row = await this.prisma.auth_tokens.findUnique({
      where: { token_hash: sha256(token) },
    });
    if (
      !row ||
      row.purpose !== purpose ||
      row.used_at ||
      row.expires_at < new Date()
    ) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    // Conditional update so a token cannot be used twice concurrently.
    const { count } = await this.prisma.auth_tokens.updateMany({
      where: { id: row.id, used_at: null },
      data: { used_at: new Date() },
    });
    if (count !== 1)
      throw new BadRequestException('This link is invalid or has expired');
    return row.user_id;
  }

  /**
   * Hands a token to the user. No email/SMS provider is configured yet, so the token is
   * logged, and returned to the caller only when EXPOSE_DEV_TOKENS=true (never in production).
   */
  deliver(
    purpose: TokenPurpose,
    destination: string,
    token: string,
  ): { devToken?: string } {
    this.logger.log(
      `[${purpose}] token issued for ${maskDestination(destination)} (connect an email/SMS provider to send it)`,
    );
    const expose =
      this.config.get<string>('EXPOSE_DEV_TOKENS') === 'true' &&
      this.config.get<string>('NODE_ENV') !== 'production';
    return expose ? { devToken: token } : {};
  }
}

function maskDestination(value: string): string {
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `***${value.slice(-4)}`;
}
