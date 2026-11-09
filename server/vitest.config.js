import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE_ENV: 'test', AI_MODE: 'mock', JWT_SECRET: 'test-secret-not-for-production' },
  },
});
