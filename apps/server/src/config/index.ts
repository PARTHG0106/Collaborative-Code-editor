import dotenv from 'dotenv';
import path from 'path';

// Load environment variables trying multiple relative paths to the root monorepo .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

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
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173', 'http://localhost:5174'],

  /** Is production? */
  isProduction: process.env.NODE_ENV === 'production',

  /** Is development? */
  isDevelopment: process.env.NODE_ENV !== 'production',

  /** JWT configuration settings */
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'default-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'default-refresh-secret',
    accessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  },
} as const;

/**
 * Validate that all required environment variables are set.
 * Called at server startup.
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

  if (config.isProduction) {
    if (!process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_SECRET === 'your-access-secret-here') {
      missing.push('JWT_ACCESS_SECRET');
    }
    if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET === 'your-refresh-secret-here') {
      missing.push('JWT_REFRESH_SECRET');
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing or insecure required environment variables in production: ${missing.join(', ')}`);
  }
}
