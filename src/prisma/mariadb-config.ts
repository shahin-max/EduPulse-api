import type { PoolConfig } from 'mariadb';

/**
 * Turns the `mysql://user:pass@host:port/db` URL used by the Prisma CLI into the
 * pool config expected by the MariaDB driver adapter (which also talks to MySQL 8).
 */
export function mariaDbConfigFromUrl(databaseUrl: string): PoolConfig {
  const url = new URL(databaseUrl);
  if (!['mysql:', 'mariadb:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must start with mysql:// or mariadb://');
  }
  const database = url.pathname.replace(/^\//, '');
  if (!database) throw new Error('DATABASE_URL must include a database name');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: Number(url.searchParams.get('connection_limit') ?? 10),
    // Needed for MySQL 8's default caching_sha2_password auth on non-TLS connections.
    allowPublicKeyRetrieval: true,
    // Prisma writes timestamps in UTC, but columns filled by MySQL itself (DEFAULT / ON UPDATE
    // CURRENT_TIMESTAMP, e.g. every updated_at) use the session time zone. On a server set to IST
    // that stored updated_at 5h30m ahead of created_at. Run every session in UTC to match.
    initSql: "SET time_zone = '+00:00'",
  };
}
