import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'sim', include: ['packages/sim/test/**/*.test.ts'] } },
      { test: { name: 'ai', include: ['packages/ai/test/**/*.test.ts'] } },
      { test: { name: 'protocol', include: ['packages/protocol/test/**/*.test.ts'] } },
      { test: { name: 'server', include: ['packages/server/test/**/*.test.ts'] } },
      { test: { name: 'client', include: ['packages/client/test/**/*.test.ts'] } },
    ],
  },
});
