import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'demos/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
