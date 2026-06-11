import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/manager.ts'],
      thresholds: {
        lines: 95
      }
    }
  }
});
