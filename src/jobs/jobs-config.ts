import type { ConfigService } from '@nestjs/config';

/**
 * Background jobs are on unless JOBS_ENABLED=false (the e2e suites turn them off so nothing
 * fires mid-test). With them off, the old fallback runs instead: due work is picked up when
 * someone reads their notifications or announcement feed.
 */
export function jobsEnabled(config: ConfigService): boolean {
  return config.get<string>('JOBS_ENABLED')?.trim().toLowerCase() !== 'false';
}
