import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

const dep = (name: string) => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  // Plugin-bundle sources under ../plugins/*/web-src are tested here against the real
  // window.ElowenUiRuntime; they live outside web/, so their react/lucide imports must resolve to
  // THIS app's node_modules (one React instance — the same guarantee the production build shim gives).
  resolve: {
    alias: {
      'react/jsx-dev-runtime': dep('react/jsx-dev-runtime.js'),
      'react/jsx-runtime': dep('react/jsx-runtime.js'),
      'react-dom': dep('react-dom'),
      react: dep('react'),
      'lucide-react': dep('lucide-react'),
    },
  },
  // Playwright E2E lives under tests/e2e/ (specs are `*.e2e.ts`, not `*.test.ts`, so `include` already
  // skips them). The explicit exclude is belt-and-suspenders: vitest must never load the fake daemon,
  // its handlers, or the Playwright specs (which import `@playwright/test`, absent from the vitest env).
  test: { environment: 'jsdom', globals: true, setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.{ts,tsx}'], exclude: ['tests/e2e/**'] },
});
