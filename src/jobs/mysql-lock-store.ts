import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type LockAcquireResult,
  type LockStore,
  LocksStorage,
} from '@nestjs/locks';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `@nestjs/locks` store on MySQL (table `job_locks`, rows found by the SHA-256 of the key so keys
 * of any length are kept apart exactly), so scheduled jobs run on one API instance
 * even when Railway runs several. Every check uses the database clock (NOW(3)), so instances agree
 * on expiry whatever their own clocks say.
 *
 * - acquire: one `INSERT ... ON DUPLICATE KEY UPDATE` that only overwrites an expired row. MySQL
 *   applies the assignments left to right and later ones see earlier results, so `expires_at`
 *   (the column every condition reads) is assigned last. Whether we won is read back by owner,
 *   a random string per acquisition, so a loser can never mistake the row for its own.
 * - renew / release: single compare-and-set UPDATEs on (key, owner, still live). Release marks the
 *   row expired instead of deleting it, so the key's fencing token keeps growing.
 */
@Injectable()
export class MysqlLockStore implements LockStore {
  constructor(
    private readonly prisma: PrismaService,
    storage: LocksStorage,
  ) {
    storage.registerSource(this);
  }

  async acquire(
    key: string,
    owner: string,
    ttl: number,
  ): Promise<LockAcquireResult> {
    const micros = BigInt(ttl) * 1000n;
    // A lock is taken once: the owner that already holds it live gets `false`. Owners are unique
    // per acquisition, so nobody else can make this check stale.
    const held = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM job_locks
      WHERE key_hash = ${hashOf(key)} AND owner = ${owner} AND expires_at > NOW(3)`;
    if (Number(held[0]?.n ?? 0) > 0) return { acquired: false };
    await this.prisma.$executeRaw`
      INSERT INTO job_locks (key_hash, lock_key, owner, fencing_token, expires_at)
      VALUES (${hashOf(key)}, ${key}, ${owner}, 1, NOW(3) + INTERVAL ${micros} MICROSECOND)
      ON DUPLICATE KEY UPDATE
        fencing_token = IF(expires_at <= NOW(3), fencing_token + 1, fencing_token),
        owner = IF(expires_at <= NOW(3), VALUES(owner), owner),
        expires_at = IF(expires_at <= NOW(3), VALUES(expires_at), expires_at)`;
    const rows = await this.prisma.$queryRaw<
      { owner: string | null; fencing_token: bigint }[]
    >`SELECT owner, fencing_token FROM job_locks WHERE key_hash = ${hashOf(key)}`;
    const row = rows[0];
    if (!row || row.owner !== owner) return { acquired: false };
    return { acquired: true, fencingToken: Number(row.fencing_token) };
  }

  async renew(key: string, owner: string, ttl: number): Promise<boolean> {
    const micros = BigInt(ttl) * 1000n;
    const changed = await this.prisma.$executeRaw`
      UPDATE job_locks SET expires_at = NOW(3) + INTERVAL ${micros} MICROSECOND
      WHERE key_hash = ${hashOf(key)} AND owner = ${owner} AND expires_at > NOW(3)`;
    return changed > 0;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const changed = await this.prisma.$executeRaw`
      UPDATE job_locks SET owner = NULL, expires_at = NOW(3)
      WHERE key_hash = ${hashOf(key)} AND owner = ${owner} AND expires_at > NOW(3)`;
    return changed > 0;
  }
}

/** The row id of a key: SHA-256 of its UTF-8 bytes (exact, whatever its length or characters). */
function hashOf(key: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(key, 'utf8').digest());
}
