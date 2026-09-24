import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  collectConfigurationErrors,
  validateEnvironment,
} from './env-validation';

/** Minimal KEY=VALUE parser mirroring dotenv's basic semantics. */
function parseEnvFile(content: string): Record<string, string> {
  const config: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    config[key] = value;
  }
  return config;
}

function validBaseConfig(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@localhost:5432/savitools',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'a'.repeat(64),
    ENCRYPTION_SECRET: 'b'.repeat(64),
    DEPLOYER_SECRET_KEY:
      'SCDIUQZJLWZLKDMARQUWYTHBSWBLDWWFMNOHAAVKPSUFPZ7NWU3LR7WL'.slice(0, 56),
    WEB_ORIGIN: 'https://savitools.example.com',
    STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    STELLAR_RPC_URL: 'https://soroban-rpc-testnet.stellar.org',
    RESEND_FROM_EMAIL: 'SaviTools <noreply@savitools.dev>',
  };
}

describe('environment configuration validation (Savitura/Savitools#197)', () => {
  it('accepts a fully populated development configuration', () => {
    const { errors } = collectConfigurationErrors(validBaseConfig());
    expect(errors).toEqual([]);
  });

  it('requires the URLs that services read at startup', () => {
    const config = validBaseConfig();
    delete config.DATABASE_URL;
    delete config.REDIS_URL;

    const { errors } = collectConfigurationErrors(config);
    expect(errors).toContain('DATABASE_URL is required');
    expect(errors).toContain('REDIS_URL is required');
  });

  it('rejects placeholder auth and encryption secrets in production', () => {
    const config = {
      ...validBaseConfig(),
      NODE_ENV: 'production',
      JWT_SECRET: 'change-me-in-production-use-a-long-random-string',
      ENCRYPTION_SECRET: 'your-encryption-secret',
      DEPLOYER_SECRET_KEY: 'your-deployer-secret-key-here',
    };

    const { errors } = collectConfigurationErrors(config);
    expect(errors).toContain('JWT_SECRET must be replaced with a generated random value');
    expect(errors).toContain(
      'ENCRYPTION_SECRET must be replaced with a generated secret',
    );
    expect(errors).toContain(
      'DEPLOYER_SECRET_KEY must be a valid Stellar secret key (56 characters starting with S)',
    );
  });

  it('only warns (never throws) for placeholder secrets outside production', () => {
    const config = {
      ...validBaseConfig(),
      NODE_ENV: 'development',
      JWT_SECRET: 'change-me-in-production-use-a-long-random-string',
      ENCRYPTION_SECRET: 'your-encryption-secret',
      DEPLOYER_SECRET_KEY: 'SBPQUUXPZWBB2Q4BJDUJU3NFAFOMK7Y6U7FP3GMEI5VYBGVOLMBB45AT',
    };

    const { errors, warnings } = collectConfigurationErrors(config);
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('enforces HTTPS for public-facing URLs in production', () => {
    const config = {
      ...validBaseConfig(),
      NODE_ENV: 'production',
      WEB_ORIGIN: 'http://savitools.example.com',
      STELLAR_HORIZON_URL: 'http://horizon.example.com',
      STELLAR_RPC_URL: 'http://rpc.example.com',
    };

    const { errors } = collectConfigurationErrors(config);
    expect(errors).toContain('WEB_ORIGIN must use HTTPS in production');
    expect(errors).toContain('STELLAR_HORIZON_URL must use HTTPS in production');
    expect(errors).toContain('STELLAR_RPC_URL must use HTTPS in production');
  });

  it('allows HTTP origins for localhost in production test setups', () => {
    const config = {
      ...validBaseConfig(),
      NODE_ENV: 'production',
      WEB_ORIGIN: 'http://localhost:3000',
    };

    const { errors } = collectConfigurationErrors(config);
    expect(errors).not.toContain('WEB_ORIGIN must use HTTPS in production');
  });

  it('enforces minimum secret lengths in production', () => {
    const config = {
      ...validBaseConfig(),
      NODE_ENV: 'production',
      JWT_SECRET: 'short-secret',
      ENCRYPTION_SECRET: 'short-secret',
    };

    const { errors } = collectConfigurationErrors(config);
    expect(errors).toContain('JWT_SECRET must be at least 32 characters in production');
    expect(errors).toContain(
      'ENCRYPTION_SECRET must be at least 32 characters in production',
    );
  });

  it('requires feature-specific variables when their features are enabled', () => {
    const withResend = {
      ...validBaseConfig(),
      RESEND_API_KEY: 're_1234567890',
    };
    delete withResend.RESEND_FROM_EMAIL;
    expect(collectConfigurationErrors(withResend).errors).toContain(
      'RESEND_FROM_EMAIL is required when RESEND_API_KEY is set',
    );

    const withFluxa = {
      ...validBaseConfig(),
      FLUXA_CLIENT_ID: 'fluxa-client',
    };
    const fluxaErrors = collectConfigurationErrors(withFluxa).errors;
    expect(fluxaErrors).toContain('FLUXA_CLIENT_SECRET is required when FLUXA_CLIENT_ID is set');
    expect(fluxaErrors).toContain('FLUXA_AUTH_URL is required when FLUXA_CLIENT_ID is set');
  });

  it('validateEnvironment aggregates every error and throws', () => {
    const config = validBaseConfig();
    delete config.JWT_SECRET;
    delete config.ENCRYPTION_SECRET;
    delete config.DEPLOYER_SECRET_KEY;

    expect(() => validateEnvironment(config)).toThrow(/JWT_SECRET is required/);
  });

  it('the documented .env.example templates validate cleanly', () => {
    // apps/api/.env.example — the per-app template (src/config → apps/api)
    const apiExample = parseEnvFile(
      readFileSync(resolve(__dirname, '../../.env.example'), 'utf8'),
    );
    // `.env.example` values use placeholders on purpose; validators flag them
    // only in production, so evaluate the template as a development setup.
    const apiResult = collectConfigurationErrors({
      ...apiExample,
      NODE_ENV: 'development',
      // The template intentionally ships placeholder secrets — swap in real
      // ones for production (documented in README).
      DEPLOYER_SECRET_KEY:
        'SCDIUQZJLWZLKDMARQUWBLDWWFMNOHAAVKPSUFPZ7NWU3LR7WLAAAAA'.slice(0, 56),
    });
    expect(apiResult.errors).toEqual([]);

    // Root .env.example — infrastructure variables only.
    const rootExample = parseEnvFile(
      readFileSync(resolve(__dirname, '../../../../.env.example'), 'utf8'),
    );
    const merged = { ...rootExample, ...apiExample, NODE_ENV: 'development' };
    const mergedResult = collectConfigurationErrors({
      ...merged,
      JWT_SECRET: 'a'.repeat(64),
      ENCRYPTION_SECRET: 'b'.repeat(64),
      DEPLOYER_SECRET_KEY:
        'SCDIUQZJLWZLKDMARQUWBLDWWFMNOHAAVKPSUFPZ7NWU3LR7WLAAAAA'.slice(0, 56),
    });
    expect(mergedResult.errors).toEqual([]);
  });
});
