import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { html, Mailer } from '@nestjs/mail';
import { createHash, randomBytes } from 'node:crypto';
import { auth_tokens_purpose } from '../generated/prisma/enums.js';
import { webUrl } from '../mail/mail.module.js';
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
    private readonly mailer: Mailer,
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
   * Hands a token to the user. Email addresses get a link by email (sent in the background, so a
   * slow mail server never delays the request or reveals whether the account exists). No SMS
   * provider is connected, so tokens for mobile numbers are only logged; admins can issue a
   * password link instead. The token is also returned when EXPOSE_DEV_TOKENS=true outside production.
   */
  deliver(
    purpose: TokenPurpose,
    destination: string,
    token: string,
  ): { devToken?: string } {
    const masked = maskDestination(destination);
    if (destination.includes('@') && purpose !== 'MOBILE_VERIFY') {
      this.mailer
        .send({ to: destination, ...this.message(purpose, token) })
        .then(() => this.logger.log(`[${purpose}] email sent to ${masked}`))
        .catch((error: unknown) =>
          this.logger.error(
            `[${purpose}] email to ${masked} failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    } else {
      this.logger.log(
        `[${purpose}] token issued for ${masked} (no SMS provider connected; not sent)`,
      );
    }
    const expose =
      this.config.get<string>('EXPOSE_DEV_TOKENS') === 'true' &&
      this.config.get<string>('NODE_ENV') !== 'production';
    return expose ? { devToken: token } : {};
  }

  private message(purpose: TokenPurpose, token: string) {
    const base = webUrl(this.config);
    const query = `token=${encodeURIComponent(token)}`;
    if (purpose === 'EMAIL_VERIFY') {
      const link = `${base}/verify-email?${query}`;
      return {
        subject: 'Verify your email for EduPulse Academy',
        html: html`<p>Hello,</p>
          <p>Please confirm this email address for your EduPulse Academy account.</p>
          <p><a href="${link}">Verify my email</a></p>
          <p>The link works for 24 hours. If you did not ask for this, you can ignore this email.</p>`,
      };
    }
    const link = `${base}/set-password?${query}`;
    return {
      subject: 'Reset your EduPulse Academy password',
      html: html`<p>Hello,</p>
        <p>We received a request to reset the password of your EduPulse Academy account.</p>
        <p><a href="${link}">Choose a new password</a></p>
        <p>The link works for 1 hour and can be used once. If you did not ask for this, you can ignore this email; your password stays the same.</p>`,
    };
  }
}

function maskDestination(value: string): string {
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return `***${value.slice(-4)}`;
}
