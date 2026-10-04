import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    maxWorkers: 2,
    minWorkers: 1,
    include: ['src/**/*.test.ts'],
    // bcrypt runs at cost 12 in the auth paths, which can exceed the default
    // 5s per-test budget on a loaded CI runner or a slow dev machine. The
    // tests are correct; give them headroom so a slow host does not flake.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Deterministic secrets so config/index.ts (which validates JWT secrets at
    // module load and throws if they are missing or <32 chars) can be imported
    // without the gitignored root .env. This lets the suite run on a clean
    // checkout and in CI, and keeps tests off real production secret values.
    env: {
      NODE_ENV: 'test',
      ENABLE_TERMINAL: 'true',
      SMTP_HOST: '',
      SMTP_USER: '',
      SMTP_PASS: '',
      SMTP_FROM: 'tests@example.test',
      HF_TOKEN: '',
      HF_GPU_TOKEN: '',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '7d',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test?schema=public',
      CORS_ORIGINS: 'http://localhost:5173',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'dist/', 'prisma/'],
    },
  },
});
