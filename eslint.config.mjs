import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

/**
 * Lean, focused lint config. The single job here is killing dead imports/vars (autofixable) so they
 * never accumulate — not enforcing a full style ruleset. Backend (`src/`) and the web app (`web/`)
 * share it. Run `npm run lint` to check, `npm run lint:fix` to autofix.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/web-dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.worktrees/**',
      '**/.artifacts/**',
      '**/benchmark-env/**',
      'web/public/**',
      'web/scripts/**',
      // The Playwright E2E harness has its own dedicated tsconfig typecheck; keep it out of the app lint
      // (its fixture `use()` callbacks trip react-hooks/rules-of-hooks). Mirrors the tsc/knip/depcruise
      // exclusions for this tree.
      'web/tests/e2e/**',
      '**/*.tsbuildinfo',
      '**/*.d.ts',
    ],
  },
  {
    // Don't touch inline `eslint-disable` directives for rules this lean config doesn't manage
    // (e.g. `no-constant-condition`) — otherwise `--fix` would strip them and lose the intent.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // Delegated to unused-imports (it can autofix imports; the base rule can't).
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', {
        vars: 'all',
        varsIgnorePattern: '^_',
        args: 'after-used',
        argsIgnorePattern: '^_',
        // A name destructured alongside a `...rest` is the standard "omit this property" idiom
        // (e.g. `const { apiKey, ...safe } = row`) — it exists only to be excluded, so don't flag it.
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Web app (Next.js + React): register the react-hooks and Next plugins so the codebase's inline
    // `eslint-disable` directives resolve, and we get hook-correctness + Next best-practice checks.
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, '@next/next': nextPlugin },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // This is a self-hosted standalone app with no image-optimization loader; every image is a
      // fixed local asset (logos, icons) or a user avatar, where `next/image` adds complexity for no
      // benefit. Plain `<img>` is the deliberate, app-wide choice.
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
);
