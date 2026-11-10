import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { RoleCode } from '../common/auth.js';
import type { AuthUser } from '../common/auth.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  buildObjectKey,
  resolveInside,
  safeDisplayName,
  safeExtension,
} from './files.service.js';
import { LearningAccessService } from './learning-access.service.js';
import {
  assertMaterialLocation,
  progressTimestamps,
} from './materials.service.js';
import { assertMarks, isLate } from './assignments.service.js';

const user = (id: number, ...roles: RoleCode[]): AuthUser => ({
  id: BigInt(id),
  publicId: 'p',
  roles,
  sessionId: 1n,
});

describe('file storage helpers', () => {
  it('builds yyyy/mm/<uuid><ext> keys that ignore the client path', () => {
    const key = buildObjectKey(
      '../../etc/passwd.PDF',
      new Date('2026-11-10T00:00:00Z'),
    );
    expect(key).toMatch(/^2026\/11\/[0-9a-f-]{36}\.pdf$/);
    expect(key).not.toContain('..');
  });

  it.each([
    ['notes.pdf', '.pdf'],
    ['archive.tar.gz', '.gz'],
    ['noext', ''],
    ['weird.p@f', ''],
    ['x.verylongextension', ''],
  ])('extension of %s is "%s"', (name, ext) =>
    expect(safeExtension(name)).toBe(ext),
  );

  it('strips directories and quotes from the display name', () => {
    expect(safeDisplayName('C:\\Users\\a\\"evil".pdf')).toBe('evil.pdf');
    expect(safeDisplayName('/tmp/')).toBe('file');
  });

  it('refuses object keys that escape the upload root', () => {
    expect(resolveInside('/srv/uploads', '2026/11/a.pdf')).toMatch(/a\.pdf$/);
    expect(() => resolveInside('/srv/uploads', '../secret')).toThrow(
      BadRequestException,
    );
    expect(() => resolveInside('/srv/uploads', '')).toThrow(
      BadRequestException,
    );
  });
});

describe('LearningAccessService.canReadFile', () => {
  function setup(
    found: {
      material?: boolean;
      assignment?: boolean;
      submission?: boolean;
    } = {},
  ) {
    const prisma = {
      study_materials: {
        findFirst: vi
          .fn()
          .mockResolvedValue(found.material ? { id: 1n } : null),
      },
      assignments: {
        findFirst: vi
          .fn()
          .mockResolvedValue(found.assignment ? { id: 1n } : null),
      },
      assignment_submissions: {
        findFirst: vi
          .fn()
          .mockResolvedValue(found.submission ? { id: 1n } : null),
      },
    };
    return {
      prisma,
      access: new LearningAccessService(prisma as unknown as PrismaService),
    };
  }
  const privateFile = {
    id: 9n,
    visibility: 'PRIVATE' as const,
    uploaded_by: 5n,
  };

  it('lets anyone read PUBLIC files', async () => {
    const { access } = setup();
    await expect(
      access.canReadFile(undefined, { ...privateFile, visibility: 'PUBLIC' }),
    ).resolves.toBe(true);
  });

  it('hides PRIVATE files from anonymous visitors', async () => {
    await expect(
      setup().access.canReadFile(undefined, privateFile),
    ).resolves.toBe(false);
  });

  it('lets admins, faculty and the uploader read PRIVATE files without lookups', async () => {
    const { access, prisma } = setup();
    await expect(
      access.canReadFile(user(1, RoleCode.ADMIN), privateFile),
    ).resolves.toBe(true);
    await expect(
      access.canReadFile(user(2, RoleCode.FACULTY), privateFile),
    ).resolves.toBe(true);
    await expect(
      access.canReadFile(user(5, RoleCode.STUDENT), privateFile),
    ).resolves.toBe(true);
    expect(prisma.study_materials.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['a published material of an enrolled course', { material: true }],
    ['an assignment attachment of their batch', { assignment: true }],
    ['their own submission', { submission: true }],
  ])('lets a student read a file through %s', async (_label, found) => {
    await expect(
      setup(found).access.canReadFile(user(7, RoleCode.STUDENT), privateFile),
    ).resolves.toBe(true);
  });

  it('denies a student with no route to the file', async () => {
    await expect(
      setup().access.canReadFile(user(7, RoleCode.STUDENT), privateFile),
    ).resolves.toBe(false);
  });

  it('only counts published material in courses the student is actively enrolled in', async () => {
    const { access, prisma } = setup();
    await access.canReadFile(user(7, RoleCode.STUDENT), privateFile);
    const where = prisma.study_materials.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      asset_id: 9n,
      is_published: true,
      chapters: { is_published: true },
    });
    expect(
      JSON.stringify(where, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ).toContain('"status":"ACTIVE"');
  });
});

describe('study material rules', () => {
  it('mirrors chk_material_location', () => {
    expect(() => assertMaterialLocation(null, null)).toThrow(
      BadRequestException,
    );
    expect(() => assertMaterialLocation(undefined, '')).toThrow(
      BadRequestException,
    );
    expect(() => assertMaterialLocation(3n, null)).not.toThrow();
    expect(() =>
      assertMaterialLocation(null, 'https://youtu.be/x'),
    ).not.toThrow();
  });

  it('stamps completion once and clears it when progress goes back', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    const earlier = new Date('2026-11-01T10:00:00Z');
    expect(progressTimestamps('COMPLETED', null, now)).toEqual({
      last_accessed_at: now,
      completed_at: now,
    });
    expect(progressTimestamps('COMPLETED', earlier, now).completed_at).toBe(
      earlier,
    );
    expect(
      progressTimestamps('IN_PROGRESS', earlier, now).completed_at,
    ).toBeNull();
  });
});

describe('assignment rules', () => {
  it('flags late submissions only when a due time exists and has passed', () => {
    const due = new Date('2026-11-10T12:00:00Z');
    expect(isLate(new Date('2026-11-10T12:00:01Z'), due)).toBe(true);
    expect(isLate(new Date('2026-11-10T11:59:59Z'), due)).toBe(false);
    expect(isLate(new Date(), null)).toBe(false);
  });

  it('keeps awarded marks within maxMarks (chk_submission_score)', () => {
    const max = new Prisma.Decimal('10.00');
    expect(() => assertMarks(10, max)).not.toThrow();
    expect(() => assertMarks(10.01, max)).toThrow(/exceed/);
    expect(() => assertMarks(-1, max)).toThrow(/negative/);
    expect(() => assertMarks(500, null)).not.toThrow();
    expect(() => assertMarks(undefined, max)).not.toThrow();
  });
});

describe('DTO validation (chk_material_location, chk_submission_content)', () => {
  async function errors<T extends object>(cls: new () => T, plain: object) {
    const { plainToInstance } = await import('class-transformer');
    const { validate } = await import('class-validator');
    return (
      await validate(plainToInstance(cls, plain), {
        whitelist: true,
        forbidNonWhitelisted: true,
      })
    ).length;
  }

  it('requires assetId or externalUrl on a new study material', async () => {
    const { CreateStudyMaterialDto } = await import('./dto/learning.dto.js');
    const base = { chapterId: 1, title: 'Notes', kind: 'PDF_NOTE' };
    expect(await errors(CreateStudyMaterialDto, base)).toBe(1);
    expect(await errors(CreateStudyMaterialDto, { ...base, assetId: 3 })).toBe(
      0,
    );
    expect(
      await errors(CreateStudyMaterialDto, {
        ...base,
        externalUrl: 'https://youtu.be/x',
      }),
    ).toBe(0);
  });

  it('requires responseText or assetId on a submission', async () => {
    const { SubmitAssignmentDto } = await import('./dto/learning.dto.js');
    expect(await errors(SubmitAssignmentDto, {})).toBe(1);
    expect(await errors(SubmitAssignmentDto, { responseText: 'answer' })).toBe(
      0,
    );
    expect(await errors(SubmitAssignmentDto, { assetId: 4 })).toBe(0);
  });
});
