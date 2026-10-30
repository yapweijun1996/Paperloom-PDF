import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__tests__/**', 'src/**/*.d.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: { statements: 60, branches: 54, functions: 61, lines: 63 },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
