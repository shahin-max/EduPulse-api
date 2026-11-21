import { SMS_SETTINGS } from '../sms/sms.service.js';

const REQUIRED = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

/** Fails fast at boot when required configuration is missing or unsafe. */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED.filter(
    (key) => typeof config[key] !== 'string' || config[key].trim() === '',
  );
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }
  if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different',
    );
  }
  // Cloudinary is optional, but half a configuration would silently fall back to the local disk.
  const cloudinary = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ];
  const set = cloudinary.filter(
    (key) => typeof config[key] === 'string' && config[key].trim() !== '',
  );
  if (set.length && set.length < cloudinary.length) {
    throw new Error(
      `Set all of ${cloudinary.join(', ')} to use Cloudinary, or none of them`,
    );
  }
  const sms = typeof config.SMS_PROVIDER === 'string'
    ? config.SMS_PROVIDER.trim().toLowerCase()
    : '';
  if (sms && sms !== 'log' && !(sms in SMS_SETTINGS))
    throw new Error('SMS_PROVIDER must be "twilio", "msg91" or empty');
  if (sms in SMS_SETTINGS) {
    const needed = SMS_SETTINGS[sms as keyof typeof SMS_SETTINGS];
    const absent = needed.filter(
      (key) => typeof config[key] !== 'string' || config[key].trim() === '',
    );
    if (absent.length)
      throw new Error(
        `SMS_PROVIDER=${sms} also needs: ${absent.join(', ')}`,
      );
  }
  const portals = config.PORTALS_OPEN;
  if (
    portals !== undefined &&
    (typeof portals !== 'string' ||
      !['', 'all', 'admin'].includes(portals.trim().toLowerCase()))
  ) {
    throw new Error('PORTALS_OPEN must be "all" or "admin"');
  }
  if (config.NODE_ENV === 'production') {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
      const value = String(config[key]);
      if (value.length < 32 || value.startsWith('change-me')) {
        throw new Error(
          `${key} must be a random string of at least 32 characters in production`,
        );
      }
    }
  }
  return config;
}
