import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { EnrollmentsService } from './enrollments.service.js';

function setup(opts: {
  student?: object | null;
  locked?: boolean;
  batch?: { capacity: number | null; status: string };
  taken?: number;
  existing?: { id: bigint; status: string } | null;
}) {
  const tx = {
    users: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.student === undefined
            ? {
                status: 'ACTIVE',
                deleted_at: null,
                user_roles: [{ roles: { code: 'STUDENT' } }],
                student_profiles: { user_id: 3n },
              }
            : opts.student,
        ),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValue(opts.locked === false ? [] : [{ id: 5n }]),
    batches: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue(opts.batch ?? { capacity: 30, status: 'ACTIVE' }),
    },
    enrollments: {
      count: vi.fn().mockResolvedValue(opts.taken ?? 0),
      findUnique: vi.fn().mockResolvedValue(opts.existing ?? null),
      create: vi.fn().mockResolvedValue({ id: 1n }),
      update: vi.fn().mockResolvedValue({ id: 9n }),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return {
    tx,
    service: new EnrollmentsService(prisma as unknown as PrismaService),
  };
}

describe('EnrollmentsService.create', () => {
  const dto = { studentUserId: 3, batchId: 5 };

  it('locks the batch row before counting PENDING + ACTIVE seats', async () => {
    const { tx, service } = setup({});
    await service.create(dto, 1n);
    expect(
      (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?'),
    ).toMatch(/FROM batches WHERE id = \? FOR UPDATE/);
    expect(tx.enrollments.count).toHaveBeenCalledWith({
      where: { batch_id: 5n, status: { in: ['PENDING', 'ACTIVE'] } },
    });
    expect(tx.enrollments.create.mock.calls[0][0].data).toMatchObject({
      student_user_id: 3n,
      batch_id: 5n,
      status: 'ACTIVE',
      created_by: 1n,
    });
  });

  it('rejects a full batch but allows unlimited capacity', async () => {
    await expect(
      setup({
        batch: { capacity: 2, status: 'ACTIVE' },
        taken: 2,
      }).service.create(dto, 1n),
    ).rejects.toThrow(new ConflictException('This batch is full'));
    await expect(
      setup({
        batch: { capacity: null, status: 'ACTIVE' },
        taken: 999,
      }).service.create(dto, 1n),
    ).resolves.toBeTruthy();
  });

  it.each(['COMPLETED', 'CANCELLED'])('rejects a %s batch', async (status) => {
    await expect(
      setup({ batch: { capacity: 30, status } }).service.create(dto, 1n),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects non-students and unknown batches', async () => {
    const faculty = {
      status: 'ACTIVE',
      deleted_at: null,
      user_roles: [{ roles: { code: 'FACULTY' } }],
      student_profiles: null,
    };
    await expect(
      setup({ student: faculty }).service.create(dto, 1n),
    ).rejects.toThrow(/active student/);
    await expect(
      setup({ locked: false }).service.create(dto, 1n),
    ).rejects.toThrow(/does not match any batch/);
  });

  it('re-opens a cancelled enrollment instead of duplicating the unique pair', async () => {
    const { tx, service } = setup({
      existing: { id: 9n, status: 'CANCELLED' },
    });
    await service.create(dto, 1n);
    expect(tx.enrollments.create).not.toHaveBeenCalled();
    expect(tx.enrollments.update.mock.calls[0][0]).toMatchObject({
      where: { id: 9n },
      data: { status: 'ACTIVE', completed_at: null },
    });
  });

  it('rejects a second active enrollment and an inverted access window', async () => {
    await expect(
      setup({ existing: { id: 9n, status: 'PENDING' } }).service.create(
        dto,
        1n,
      ),
    ).rejects.toThrow(/already enrolled/);
    await expect(
      setup({}).service.create(
        {
          ...dto,
          accessStartsAt: new Date('2027-02-01'),
          accessEndsAt: new Date('2027-01-01'),
        },
        1n,
      ),
    ).rejects.toThrow(/accessEndsAt/);
  });
});
