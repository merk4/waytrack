import { defineConfig } from 'vitest/config';

/** Opt-in live checks against real providers: `npm run test:live` (needs .env). */
export default defineConfig({
  test: { include: ['test/live/**/*.live.test.ts'], environment: 'node', testTimeout: 60_000, fileParallelism: false },
});
