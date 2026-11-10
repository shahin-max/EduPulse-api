import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'dotenv';

/**
 * Loads .env.test for the e2e suites. The suites delete every row, so they refuse to run
 * unless the database name ends in "_test". E2E_DATABASE_URL (from the shell) overrides the
 * URL so several suites can run in parallel against separate test databases.
 */
export function loadTestEnv(): Record<string, string> {
  if (!existsSync('.env.test')) {
    throw new Error(
      'Missing .env.test. Copy .env.test.example to .env.test and point it at a disposable *_test database.',
    );
  }
  const env: Record<string, string> = {
    ...parse(readFileSync('.env.test')),
    NODE_ENV: 'test',
  };
  if (process.env.E2E_DATABASE_URL)
    env.DATABASE_URL = process.env.E2E_DATABASE_URL;
  const database = new URL(env.DATABASE_URL ?? 'mysql://x/').pathname.replace(
    /^\//,
    '',
  );
  if (!database.endsWith('_test')) {
    throw new Error(
      `Refusing to run e2e tests against '${database}': the database name must end in '_test'.`,
    );
  }
  if (process.env.E2E_UPLOAD_DIR) env.UPLOAD_DIR = process.env.E2E_UPLOAD_DIR;
  return env;
}
