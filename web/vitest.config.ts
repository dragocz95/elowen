import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

const dep = (name: string) => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Plugin-bundle sources under ../plugins/*/web-src are imported by suites in tests/pluginUi/ and
  // exercised against the real window.ElowenUiRuntime; they live outside web/, so their react/lucide
  // imports must resolve to THIS app's node_modules (one React instance — the same guarantee the
  // production build shim gives).
  server: { fs: { allow: ['..'] } },
  resolve: {
    alias: {
      'react/jsx-dev-runtime': dep('react/jsx-dev-runtime.js'),
      'react/jsx-runtime': dep('react/jsx-runtime.js'),
      'react-dom': dep('react-dom'),
      react: dep('react'),
      'lucide-react': dep('lucide-react'),
      '@testing-library/react': dep('@testing-library/react'),
      msw: dep('msw'),
      'msw/node': dep('msw/node'),
    },
  },
  // Playwright E2E lives under tests/e2e/ (specs are `*.e2e.ts`, not `*.test.ts`, so `include` already
  // skips them). The explicit exclude is belt-and-suspenders: vitest must never load the fake daemon,
  // its handlers, or the Playwright specs (which import `@playwright/test`, absent from the vitest env).
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // A plugin's own bundle tests are NOT collected from ../plugins/*/web-src any more: every plugin that
    // shipped them has moved to the registry, which runs them itself. The glob that used to reach in there
    // matched nothing once work left, and a glob matching nothing is how 26 suites go quiet without a word.
    // tests/contract/pluginWebTestHoming.test.ts fails if a bundled plugin grows a test file again, so the
    // choice stays visible instead of silently dropping it.
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**'],
  },
});
