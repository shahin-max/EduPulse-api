import { LocksStorage } from '@nestjs/locks';
import { lockStoreContract } from '@nestjs/locks/testing';
import { MysqlLockStore } from '../src/jobs/mysql-lock-store.js';
import { closeTestApp, createTestApp, TestContext } from './helpers.js';

/** The MySQL job lock store against the official @nestjs/locks store contract (real time, ~30 s). */
describe('MysqlLockStore contract (e2e)', () => {
  let ctx: TestContext;
  let store: MysqlLockStore;

  beforeAll(async () => {
    ctx = await createTestApp();
    store = new MysqlLockStore(ctx.prisma, new LocksStorage());
  });

  afterAll(async () => {
    await closeTestApp(ctx);
  });

  for (const c of lockStoreContract(() => store, { concurrent: true })) {
    it(c.name, () => c.run(), 20_000);
  }
});
