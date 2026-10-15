import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Repository tests exercise the real SQLite repositories. Always redirect them
// to an isolated temporary database so a test run cannot mutate data/matching.db.
process.env.MATCHING_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'matching-tool-v2-vitest-'));

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/server/**', 'src/app/**'],
    },
  },
  resolve: {
    alias: {
      '@core': './src/core',
      '@server': './src/server',
      '@observability': './src/observability',
      '@storage': './src/storage',
    },
  },
});
