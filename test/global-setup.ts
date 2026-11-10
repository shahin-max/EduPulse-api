import { execSync } from 'node:child_process';
import { loadTestEnv } from './test-env.js';

/** Brings the test database schema up to date before the e2e suite runs. */
export default function setup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, ...loadTestEnv() },
  });
}
