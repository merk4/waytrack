import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Live provider checks are opt-in (`npm run test:live`); the default suite never touches the network.
    exclude: ['test/live/**', 'node_modules/**'],
    environment: 'node',
  },
});
