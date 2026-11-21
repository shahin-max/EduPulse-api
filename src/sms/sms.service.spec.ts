import type { ConfigService } from '@nestjs/config';
import { validateEnv } from '../config/env.validation.js';
import { SmsService, type SmsMessage } from './sms.service.js';

const config = (vars: Record<string, string>) =>
  ({
    get: (k: string) => vars[k],
    getOrThrow: (k: string) => {
      if (vars[k] === undefined) throw new Error(`missing ${k}`);
      return vars[k];
    },
  }) as unknown as ConfigService;

const message: SmsMessage = {
  kind: 'PASSWORD_RESET',
  to: '+919876543210',
  link: 'https://edupulse.test/set-password?token=abc',
  text: 'EduPulse Academy: choose a new password: https://edupulse.test/set-password?token=abc',
};

describe('SmsService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('only logs without a provider', async () => {
    await new SmsService(config({})).send(message);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends through Twilio with basic auth and a From number', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    await new SmsService(
      config({
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC123',
        TWILIO_AUTH_TOKEN: 'secret',
        TWILIO_FROM: '+15005550006',
      }),
    ).send(message);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
    );
    const body = init.body as URLSearchParams;
    expect(body.get('To')).toBe('+919876543210');
    expect(body.get('From')).toBe('+15005550006');
    expect(body.get('Body')).toBe(message.text);
  });

  it('uses a Twilio Messaging Service SID when TWILIO_FROM starts with MG', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
    await new SmsService(
      config({
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 't',
        TWILIO_FROM: 'MG999',
      }),
    ).send(message);
    const body = (fetchMock.mock.calls[0][1] as RequestInit)
      .body as URLSearchParams;
    expect(body.get('MessagingServiceSid')).toBe('MG999');
    expect(body.get('From')).toBeNull();
  });

  it('sends the link to the kind’s MSG91 template, number without "+"', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"type":"success"}', { status: 200 }),
    );
    await new SmsService(
      config({
        SMS_PROVIDER: 'msg91',
        MSG91_AUTH_KEY: 'key',
        MSG91_TEMPLATE_PASSWORD_RESET: 'tpl-reset',
        MSG91_TEMPLATE_MOBILE_VERIFY: 'tpl-verify',
      }),
    ).send(message);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://control.msg91.com/api/v5/flow');
    expect((init.headers as Record<string, string>).authkey).toBe('key');
    expect(JSON.parse(init.body as string)).toEqual({
      template_id: 'tpl-reset',
      short_url: '0',
      recipients: [{ mobiles: '919876543210', link: message.link }],
    });
  });

  it('throws on a provider error, including MSG91 errors answered with 200', async () => {
    const msg91 = new SmsService(
      config({
        SMS_PROVIDER: 'msg91',
        MSG91_AUTH_KEY: 'key',
        MSG91_TEMPLATE_PASSWORD_RESET: 'a',
        MSG91_TEMPLATE_MOBILE_VERIFY: 'b',
      }),
    );
    fetchMock.mockResolvedValue(
      new Response('{"type":"error","message":"Invalid template"}', {
        status: 200,
      }),
    );
    await expect(msg91.send(message)).rejects.toThrow(/Invalid template/);
    fetchMock.mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(msg91.send(message)).rejects.toThrow(/401/);
  });
});

describe('validateEnv SMS settings', () => {
  const base = {
    DATABASE_URL: 'mysql://x/y',
    JWT_ACCESS_SECRET: 'a',
    JWT_REFRESH_SECRET: 'b',
  };

  it('needs every setting of the chosen provider', () => {
    expect(() => validateEnv({ ...base, SMS_PROVIDER: 'twilio' })).toThrow(
      /TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM/,
    );
    expect(() => validateEnv({ ...base, SMS_PROVIDER: 'pigeon' })).toThrow(
      /must be "twilio", "msg91"/,
    );
    expect(() => validateEnv({ ...base, SMS_PROVIDER: '' })).not.toThrow();
  });
});
