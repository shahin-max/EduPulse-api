import type { ConfigService } from '@nestjs/config';
import type { Mailer } from '@nestjs/mail';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

function setup(vars: Record<string, string>) {
  const prisma = {
    notifications: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    users: {
      findMany: vi.fn().mockResolvedValue([
        { email: 'amy@test.local', full_name: 'Amy <b>' },
        { email: 'ben@test.local', full_name: 'Ben' },
      ]),
    },
  };
  const send = vi.fn().mockResolvedValue({});
  const service = new NotificationsService(
    prisma as unknown as PrismaService,
    { send } as unknown as Mailer,
    { get: (k: string) => vars[k] } as unknown as ConfigService,
  );
  return { prisma, send, service };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('NotificationsService email copies', () => {
  const input = {
    title: 'Fee invoice ALG/26-27/0001',
    message: '₹5,000.00, due 30 Nov 2026.',
    linkUrl: '/student/fees#invoice-1',
    email: true,
  };

  it('emails each recipient with an address, with a link to the portal', async () => {
    const { send, service, prisma } = setup({
      SMTP_URL: 'smtp://mail',
      APP_WEB_URL: 'https://edupulse.test/',
    });
    await service.notify([1n, 2n, 2n], input);
    await flush();
    expect(prisma.users.findMany.mock.calls[0][0].where).toMatchObject({
      id: { in: [1n, 2n] },
      email: { not: null },
    });
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0] as { to: string; subject: string; html: unknown };
    expect(first.to).toBe('amy@test.local');
    expect(first.subject).toBe(input.title);
    const body = String(first.html);
    expect(body).toContain('https://edupulse.test/student/fees#invoice-1');
    // Names are escaped.
    expect(body).toContain('Amy &lt;b&gt;');
  });

  it('sends nothing without SMTP, when switched off, or when not asked', async () => {
    for (const [vars, extra] of [
      [{}, {}],
      [{ SMTP_URL: 'smtp://mail', EMAIL_NOTIFICATIONS: 'false' }, {}],
      [{ SMTP_URL: 'smtp://mail' }, { email: false }],
    ] as const) {
      const { send, service } = setup(vars);
      await service.notify([1n], { ...input, ...extra });
      await flush();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('never fails the caller when sending fails', async () => {
    const { send, service } = setup({ SMTP_URL: 'smtp://mail' });
    send.mockRejectedValue(new Error('SMTP down'));
    await expect(service.notify([1n], input)).resolves.toBe(2);
    await flush();
  });
});
