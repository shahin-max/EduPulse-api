import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { validateEnv } from '../config/env.validation.js';
import { mariaDbConfigFromUrl } from '../prisma/mariadb-config.js';
import { PrismaExceptionFilter } from './prisma-exception.filter.js';
import { paginated } from './pagination.js';
import './bigint-json.js';

describe('BigInt JSON', () => {
  it('serialises safe ids as numbers and huge ones as strings', () => {
    expect(JSON.stringify({ id: 42n })).toBe('{"id":42}');
    expect(JSON.stringify({ id: 2n ** 63n })).toBe(`{"id":"${2n ** 63n}"}`);
  });
});

describe('PrismaExceptionFilter', () => {
  function run(code: string, message = 'boom') {
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    new PrismaExceptionFilter().catch(
      new Prisma.PrismaClientKnownRequestError(message, {
        code,
        clientVersion: 'test',
      }),
      host,
    );
    return { status, body: json.mock.calls[0][0] as { message: string } };
  }

  it.each([
    ['P2002', HttpStatus.CONFLICT],
    ['P2003', HttpStatus.CONFLICT],
    ['P2025', HttpStatus.NOT_FOUND],
    ['P2039', HttpStatus.BAD_REQUEST],
    ['P9999', HttpStatus.INTERNAL_SERVER_ERROR],
  ])('maps %s to %i without leaking the driver message', (code, expected) => {
    const { status, body } = run(code);
    expect(status).toHaveBeenCalledWith(expected);
    expect(body.message).not.toContain('boom');
  });

  it('names the CHECK constraint that was violated', () => {
    const { body } = run(
      'P2039',
      "Database error. Code: `3819`. Message: `Check constraint 'chk_batch_dates' is violated.`",
    );
    expect(body.message).toBe(
      'The data breaks the database rule chk_batch_dates',
    );
  });

  it('explains writes to generated columns', () => {
    const { body } = run(
      'P2039',
      "Database error. Code: `3105`. Message: `The value specified for generated column 'amount_due' in table 'fee_invoices' is not allowed.`",
    );
    expect(body.message).toBe(
      'amount_due is calculated by the database and cannot be set',
    );
  });
});

describe('validateEnv', () => {
  const ok = {
    DATABASE_URL: 'mysql://u:p@h:3306/d',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
  };
  it('accepts a complete config and rejects gaps, shared or placeholder secrets', () => {
    expect(validateEnv(ok)).toBe(ok);
    expect(() => validateEnv({ ...ok, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL/,
    );
    expect(() =>
      validateEnv({ ...ok, JWT_REFRESH_SECRET: ok.JWT_ACCESS_SECRET }),
    ).toThrow(/different/);
    expect(() =>
      validateEnv({
        ...ok,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'change-me-access-secret-at-least-32-chars',
      }),
    ).toThrow();
  });
});

describe('mariaDbConfigFromUrl', () => {
  it('decodes URL-encoded credentials (e.g. %40 for @)', () => {
    expect(
      mariaDbConfigFromUrl(
        'mysql://root:Pass%40123@127.0.0.1:3306/edupulse_lms',
      ),
    ).toMatchObject({
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: 'Pass@123',
      database: 'edupulse_lms',
    });
    expect(() => mariaDbConfigFromUrl('mysql://u:p@h:3306')).toThrow(
      /database name/,
    );
  });
});

describe('paginated', () => {
  it('computes page metadata', () => {
    expect(paginated([1], 41, { page: 2, limit: 20 }).meta).toEqual({
      page: 2,
      limit: 20,
      total: 41,
      totalPages: 3,
    });
  });
});
