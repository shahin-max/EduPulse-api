import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LogMailTransport,
  MailModule,
  SmtpTransport,
  type MailTransport,
} from '@nestjs/mail';

const logger = new Logger('Mail');

/**
 * SMTP when SMTP_URL is set (smtp://user:pass@host:587, or smtps://...:465). Without it, mail is
 * only logged: in full outside production (so reset links can be followed locally), and without
 * the body in production, so tokens never end up in production logs.
 */
export function mailTransport(config: ConfigService): MailTransport {
  const url = config.get<string>('SMTP_URL')?.trim();
  if (url) return new SmtpTransport({ url, pool: true });
  const production = config.get<string>('NODE_ENV') === 'production';
  if (production)
    logger.warn(
      'SMTP_URL is not set: emails (password reset, verification) are logged, not sent',
    );
  return new LogMailTransport({ body: !production });
}

/** Base URL of the website, for links in emails. Falls back to the first CORS origin. */
export function webUrl(config: ConfigService): string {
  const explicit = config.get<string>('APP_WEB_URL')?.trim();
  const fallback = config.get<string>('CORS_ORIGINS')?.split(',')[0]?.trim();
  return (explicit || fallback || 'http://localhost:3000').replace(/\/+$/, '');
}

@Module({
  imports: [
    MailModule.forRootAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        transport: mailTransport(config),
        from:
          config.get<string>('MAIL_FROM')?.trim() ||
          'EduPulse Academy <no-reply@edupulse.local>',
      }),
    }),
  ],
})
export class AppMailModule {}
