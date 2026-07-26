import dotenv from 'dotenv';
import path from 'path';

// Single, explicit path to the monorepo root .env. In production the platform
// injects real environment variables and this is a no-op.
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

/**
 * Values that look like secrets but are not. Shipping any of these is
 * equivalent to having no secret at all, because they are public knowledge.
 */
const PLACEHOLDERS = new Set([
  'your-access-secret-here',
  'your-refresh-secret-here',
  'default-access-secret',
  'default-refresh-secret',
  'changeme',
  'change-me',
  'secret',
  'password',
]);

/**
 * Reads a required secret from the environment.
 *
 * Previously these fell back to 'default-access-secret', and validateConfig()
 * only rejected the placeholder string when NODE_ENV === 'production'. That
 * meant an unset variable produced a server that happily signed and verified
 * tokens with a value published in this repository, letting anyone forge a
 * session for any account. Failing to boot is the correct behaviour.
 */
function requireSecret(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Refusing to start rather than fall back to a default secret.`,
    );
  }

  if (PLACEHOLDERS.has(value.trim().toLowerCase())) {
    throw new Error(
      `Environment variable ${name} is set to a well-known placeholder value. Generate a real secret with: openssl rand -base64 48`,
    );
  }

  if (value.length < 32) {
    throw new Error(
      `Environment variable ${name} must be at least 32 characters (got ${value.length}). Generate one with: openssl rand -base64 48`,
    );
  }

  return value;
}

export const config = {
  /** Server port */
  port: parseInt(process.env.PORT || '3000', 10),

  /** Node environment */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** Database URL (sslmode stripped — we handle SSL in code to avoid pg v8 verify-full override) */
  databaseUrl: (() => {
    const raw = process.env.DATABASE_URL || '';
    try {
      const u = new URL(raw);
      u.searchParams.delete('sslmode');
      return u.toString();
    } catch {
      return raw;
    }
  })(),

  /** Whether DATABASE_URL originally had sslmode */
  databaseSsl: (process.env.DATABASE_URL || '').includes('sslmode='),

  /** CORS allowed origins */
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || [
    'http://localhost:5173',
    'http://localhost:5174',
  ],

  /** Is production? */
  isProduction: process.env.NODE_ENV === 'production',

  /** Is development? */
  isDevelopment: process.env.NODE_ENV !== 'production',

  /**
   * Interactive shell access over the socket. Off unless explicitly enabled,
   * because it hands a workspace member a real process on the API host.
   */
  enableTerminal: process.env.ENABLE_TERMINAL === 'true',

  /** JWT configuration settings */
  jwt: {
    accessSecret: requireSecret('JWT_ACCESS_SECRET'),
    refreshSecret: requireSecret('JWT_REFRESH_SECRET'),
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
} as const;

/**
 * Validate that all required environment variables are set.
 * Called at server startup. JWT secrets are already validated at module load
 * by requireSecret(), so this only covers the remaining configuration.
 */
export function validateConfig(): void {
  const missing: string[] = [];

  const dbUrl = process.env.DATABASE_URL || '';
  if (dbUrl) {
    const masked = dbUrl.replace(/:([^:@]+)@/, ':***@');
    console.info(`ℹ️ Loaded DATABASE_URL: ${masked}`);
  } else {
    console.warn('⚠️ DATABASE_URL is not set in process.env!');
  }

  if (!config.databaseUrl) {
    missing.push('DATABASE_URL');
  }

  if (config.isProduction && !process.env.CORS_ORIGINS) {
    missing.push('CORS_ORIGINS');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
