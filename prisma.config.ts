import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Optional so `prisma generate` (run on npm install) works before .env exists.
  // Commands that touch the database fail with a clear error when it is missing.
  ...(url ? { datasource: { url } } : {}),
});
