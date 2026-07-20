import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Playwright E2E lives under tests/e2e/ (specs are `*.e2e.ts`, not `*.test.ts`, so `include` already
  // skips them). The explicit exclude is belt-and-suspenders: vitest must never load the fake daemon,
  // its handlers, or the Playwright specs (which import `@playwright/test`, absent from the vitest env).
  test: { environment: 'jsdom', globals: true, setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.{ts,tsx}'], exclude: ['tests/e2e/**'] },
});
