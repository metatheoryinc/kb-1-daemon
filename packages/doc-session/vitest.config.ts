import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/manager.ts', 'src/session.ts'],
      thresholds: {
        'src/manager.ts': {
          lines: 95
        },
        'src/session.ts': {
          lines: 90
        }
      }
    }
  }
});
