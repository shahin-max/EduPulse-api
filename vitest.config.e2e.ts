import { defineConfig } from 'vitest/config';
import { loadTestEnv } from './test/test-env.js';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    env: loadTestEnv(),
    globalSetup: ['./test/global-setup.ts'],
    // The suites share one database.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
