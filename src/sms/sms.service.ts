import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** What an SMS is for; MSG91 needs a DLT-approved template per kind. */
export type SmsKind = 'PASSWORD_RESET' | 'MOBILE_VERIFY';

export interface SmsMessage {
  kind: SmsKind;
  /** E.164, e.g. +919876543210 (how mobiles are stored). */
  to: string;
  /** The link the message carries (set-password or verify page). */
  link: string;
  /** Full text, for providers that take free text (Twilio). */
  text: string;
}

export type SmsProvider = 'twilio' | 'msg91' | 'log';

export function smsProvider(config: ConfigService): SmsProvider {
  const value = config.get<string>('SMS_PROVIDER')?.trim().toLowerCase();
  return value === 'twilio' || value === 'msg91' ? value : 'log';
}

/** Settings each provider needs; checked at boot by validateEnv. */
export const SMS_SETTINGS: Record<Exclude<SmsProvider, 'log'>, string[]> = {
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'],
  msg91: [
    'MSG91_AUTH_KEY',
    'MSG91_TEMPLATE_PASSWORD_RESET',
    'MSG91_TEMPLATE_MOBILE_VERIFY',
  ],
};

const TIMEOUT_MS = 10_000;

/**
 * Sends password reset and mobile verification links by SMS.
 *
 * - `SMS_PROVIDER=twilio`: Twilio Messages API with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
 *   TWILIO_FROM (a Twilio number, or a Messaging Service SID starting with "MG").
 * - `SMS_PROVIDER=msg91`: MSG91 Flow API (India, DLT) with MSG91_AUTH_KEY and one approved template
 *   per kind (MSG91_TEMPLATE_PASSWORD_RESET, MSG91_TEMPLATE_MOBILE_VERIFY); each template puts the
 *   link where its `##link##` variable is.
 * - Otherwise messages are only logged (the link too, outside production).
 *
 * `send` throws on a provider error; callers decide whether that matters.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  get provider(): SmsProvider {
    return smsProvider(this.config);
  }

  async send(message: SmsMessage): Promise<void> {
    const provider = this.provider;
    if (provider === 'twilio') return this.twilio(message);
    if (provider === 'msg91') return this.msg91(message);
    const production = this.config.get<string>('NODE_ENV') === 'production';
    this.logger.log(
      `[${message.kind}] SMS to ***${message.to.slice(-4)} not sent (SMS_PROVIDER not set)` +
        (production ? '' : `: ${message.text}`),
    );
  }

  private async twilio(message: SmsMessage): Promise<void> {
    const sid = this.setting('TWILIO_ACCOUNT_SID');
    const token = this.setting('TWILIO_AUTH_TOKEN');
    const from = this.setting('TWILIO_FROM');
    const body = new URLSearchParams({ To: message.to, Body: message.text });
    if (from.startsWith('MG')) body.set('MessagingServiceSid', from);
    else body.set('From', from);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok)
      throw new Error(`Twilio answered ${res.status}: ${await safeText(res)}`);
  }

  private async msg91(message: SmsMessage): Promise<void> {
    const template = this.setting(
      message.kind === 'PASSWORD_RESET'
        ? 'MSG91_TEMPLATE_PASSWORD_RESET'
        : 'MSG91_TEMPLATE_MOBILE_VERIFY',
    );
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: {
        authkey: this.setting('MSG91_AUTH_KEY'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        template_id: template,
        short_url: '0',
        // MSG91 wants the number with the country code and no "+".
        recipients: [{ mobiles: message.to.replace(/^\+/, ''), link: message.link }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await safeText(res);
    // MSG91 can answer 200 with {"type":"error"}.
    if (!res.ok || /"type"\s*:\s*"error"/.test(text))
      throw new Error(`MSG91 answered ${res.status}: ${text}`);
  }

  private setting(key: string): string {
    return this.config.getOrThrow<string>(key).trim();
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

@Global()
@Module({ providers: [SmsService], exports: [SmsService] })
export class SmsModule {}
