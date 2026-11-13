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
