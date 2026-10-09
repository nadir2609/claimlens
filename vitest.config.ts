import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['shared/src/**/*.test.ts', 'server/test/**/*.test.ts', 'client/src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
