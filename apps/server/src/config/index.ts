import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from root .env file
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
// Also try local .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  /** Server port */
  port: parseInt(process.env.PORT || '4000', 10),

  /** Node environment */
  nodeEnv: process.env.NODE_ENV || 'development',

  /** Database URL */
  databaseUrl: process.env.DATABASE_URL || '',

  /** CORS allowed origins */
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:5173'],

  /** Is production? */
  isProduction: process.env.NODE_ENV === 'production',

  /** Is development? */
  isDevelopment: process.env.NODE_ENV !== 'production',
} as const;

/**
 * Validate that all required environment variables are set.
 * Called at server startup.
 */
export function validateConfig(): void {
  const required: (keyof typeof config)[] = ['databaseUrl'];
  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
