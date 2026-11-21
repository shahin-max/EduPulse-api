-- Locks for scheduled jobs (@nestjs/locks), so a job runs on one API instance at a time.
-- Rows are found by the SHA-256 of the key, so keys of any length are kept apart exactly (case,
-- spaces and Unicode forms all count); the key itself is stored for reading. A released or
-- expired lock keeps its row, so the key's fencing token only ever grows. Expiry is measured
-- with the database clock (NOW(3)).
CREATE TABLE `job_locks` (
  `key_hash` binary(32) NOT NULL,
  `lock_key` text NOT NULL,
  `owner` varchar(128) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `fencing_token` bigint unsigned NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  PRIMARY KEY (`key_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
