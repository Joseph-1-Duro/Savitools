import { Logger } from '@nestjs/common';

/**
 * Startup environment validation (Savitura/Savitools#197).
 *
 * Keeps the runtime reads in the codebase and the documented templates
 * honest: required URLs must be present, production must use HTTPS, auth and
 * encryption secrets must not be placeholders, and feature flags that enable
 * optional modules must be accompanied by the variables those modules read.
 */

const PLACEHOLDER_PATTERNS = [
  /^change-me/i,
  /^changeme/i,
  /^your-/i,
  /placeholder/i,
  /^secret$/i,
  /^password$/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value.trim()));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Loopback origins are exempt from the production HTTPS rule. */
function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Runtime-read variables and their exact purposes — keep in sync with the
 *  `.env.example` templates. */
export interface EnvValidationResult {
  errors: string[];
  warnings: string[];
}

export function collectConfigurationErrors(
  config: Record<string, unknown>,
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (key: string): string | undefined => {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : undefined;
  };
  const nodeEnv = (get('NODE_ENV') ?? 'development').toLowerCase();
  const isProduction = nodeEnv === 'production';

  // ─── Required URLs ────────────────────────────────────────────────────────
  const databaseUrl = get('DATABASE_URL');
  if (!databaseUrl) {
    errors.push('DATABASE_URL is required');
  } else if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
    errors.push('DATABASE_URL must be a PostgreSQL connection string');
  }

  const redisUrl = get('REDIS_URL');
  if (!redisUrl) {
    errors.push('REDIS_URL is required');
  } else if (!/^rediss?:\/\//i.test(redisUrl)) {
    errors.push('REDIS_URL must be a Redis connection string');
  }

  // ─── Auth & encryption secrets ────────────────────────────────────────────
  const jwtSecret = get('JWT_SECRET');
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required (JwtModule reads it at startup)');
  } else if (isPlaceholder(jwtSecret)) {
    const message = 'JWT_SECRET must be replaced with a generated random value';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  const encryptionSecret = get('ENCRYPTION_SECRET');
  if (!encryptionSecret) {
    const message =
      'ENCRYPTION_SECRET is required (auth vault/connected-account encryption derives per-user keys from it)';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  } else if (isPlaceholder(encryptionSecret)) {
    const message =
      'ENCRYPTION_SECRET must be replaced with a generated secret';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  } else if (isProduction && encryptionSecret.length < 32) {
    errors.push('ENCRYPTION_SECRET must be at least 32 characters in production');
  }

  if (isProduction && jwtSecret && jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters in production');
  }

  // ─── Production HTTPS ─────────────────────────────────────────────────────
  if (isProduction) {
    for (const key of ['WEB_ORIGIN', 'STELLAR_HORIZON_URL', 'STELLAR_RPC_URL'] as const) {
      const value = get(key);
      if (value && isHttpUrl(value) && !isLoopbackOrigin(value)) {
        errors.push(`${key} must use HTTPS in production`);
      }
    }
  }

  // ─── Contracts module (eagerly constructed — required at startup) ─────────
  const deployerSecret = get('DEPLOYER_SECRET_KEY');
  if (!deployerSecret) {
    errors.push(
      'DEPLOYER_SECRET_KEY is required (ContractsService calls getOrThrow during startup)',
    );
  } else if (!/^S[0-9A-Z]{55}$/.test(deployerSecret)) {
    const message =
      'DEPLOYER_SECRET_KEY must be a valid Stellar secret key (56 characters starting with S)';
    if (isProduction) errors.push(message);
    else warnings.push(message);
  }

  // ─── Feature-specific settings ────────────────────────────────────────────
  if (get('RESEND_API_KEY') && !get('RESEND_FROM_EMAIL')) {
    errors.push('RESEND_FROM_EMAIL is required when RESEND_API_KEY is set');
  }

  const fluxaClientId = get('FLUXA_CLIENT_ID');
  if (fluxaClientId) {
    if (!get('FLUXA_CLIENT_SECRET')) {
      errors.push('FLUXA_CLIENT_SECRET is required when FLUXA_CLIENT_ID is set');
    }
    if (!get('FLUXA_AUTH_URL')) {
      errors.push('FLUXA_AUTH_URL is required when FLUXA_CLIENT_ID is set');
    }
  }

  return { errors, warnings };
}

/**
 * ConfigModule `validate` hook: throws a single aggregated error listing
 * every misconfiguration, so operators see all problems at once instead of
 * discovering them one failed `getOrThrow` at a time.
 */
export function validateEnvironment(config: Record<string, unknown>): Record<string, unknown> {
  const { errors, warnings } = collectConfigurationErrors(config);
  const logger = new Logger('EnvironmentValidation');
  for (const warning of warnings) {
    logger.warn(warning);
  }
  if (errors.length > 0) {
    throw new Error(
      `Environment configuration failed validation:\n- ${errors.join('\n- ')}`,
    );
  }
  return config;
}
