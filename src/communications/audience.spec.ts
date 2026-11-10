import { audienceFilter, batchRuleError, canSee } from './audience.js';
import { NotificationsService } from './notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('canSee / audienceFilter', () => {
  const batchAnn = (batch: bigint) => ({
    audience: 'BATCH' as const,
    batch_id: batch,
  });

  it('shows ALL to everyone', () => {
    expect(canSee({ audience: 'ALL', batch_id: null }, [], [])).toBe(true);
  });

  it('matches role audiences', () => {
    expect(
      canSee({ audience: 'STUDENTS', batch_id: null }, ['STUDENT'], []),
    ).toBe(true);
    expect(
      canSee({ audience: 'FACULTY', batch_id: null }, ['STUDENT'], []),
    ).toBe(false);
    expect(
      canSee({ audience: 'ADMINS', batch_id: null }, ['FACULTY', 'ADMIN'], []),
    ).toBe(true);
  });

  it('shows BATCH announcements only to members of that batch (admins see all)', () => {
    expect(canSee(batchAnn(5n), ['STUDENT'], [5n, 9n])).toBe(true);
    expect(canSee(batchAnn(6n), ['STUDENT'], [5n])).toBe(false);
    expect(canSee(batchAnn(6n), ['ADMIN'], 'all')).toBe(true);
  });

  it('builds the equivalent query filters', () => {
    expect(audienceFilter(['STUDENT'], [5n])).toEqual([
      { audience: 'ALL' },
      { audience: { in: ['STUDENTS'] } },
      { audience: 'BATCH', batch_id: { in: [5n] } },
    ]);
    expect(audienceFilter(['STUDENT'], [])).toHaveLength(2);
    expect(audienceFilter(['ADMIN'], 'all')).toContainEqual({
      audience: 'BATCH',
    });
  });
});

describe('batchRuleError (chk_announcement_batch)', () => {
  it('requires a batch exactly for BATCH audience', () => {
    expect(batchRuleError('BATCH', 1n)).toBeNull();
    expect(batchRuleError('ALL', null)).toBeNull();
    expect(batchRuleError('BATCH', null)).toMatch(/required/);
    expect(batchRuleError('STUDENTS', 2n)).toMatch(/only allowed/);
  });
});

describe('NotificationsService.notify', () => {
  it('de-duplicates recipients and writes in chunks of 1000', async () => {
    const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({
      count: data.length,
    }));
    const service = new NotificationsService({
      notifications: { createMany },
    } as unknown as PrismaService);
    const ids = [
      ...Array.from({ length: 1500 }, (_, i) => BigInt(i + 1)),
      1n,
      2n,
    ];
    const created = await service.notify(ids, { title: 'Hi', message: 'Body' });
    expect(created).toBe(1500);
    expect(createMany).toHaveBeenCalledTimes(2);
    expect(createMany.mock.calls[0][0].data).toHaveLength(1000);
  });
});
