# Deterministic Dist Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Elowen production build remove stale generated output and fail if `dist/` no longer matches TypeScript sources plus deliberately copied JavaScript assets.

**Architecture:** `scripts/dist-integrity.mjs` owns only two operations: safely clean the repository-local `dist/` directory and compare expected build JavaScript paths to actual paths. npm `prebuild`/`postbuild` invoke those operations around the existing compiler and copy steps. Knip remains the source-graph dead-code gate because generated output has dynamic entrypoints and is intentionally ignored by Git.

**Tech Stack:** Node.js 22 ESM, Node `fs`/`path`, Vitest, npm lifecycle hooks, TypeScript build output.

## Global Constraints

- Delete only the resolved direct `dist/` child of an Elowen repository root; never accept a user-provided delete path.
- Treat `.ts`/`.tsx` as `.js`, `.mts` as `.mjs`, and `.cts` as `.cjs`; exclude declaration files.
- Allow copied JavaScript assets only when they exist under source `plugins/` or `prompts/` and preserve their path beneath `dist/`.
- Do not change terminal behavior, publish npm, push a branch, or include unrelated `package-lock.json`/web work.
- Each completed logical change receives its own local conventional commit.

---

### Task 1: Test and implement the dist-integrity boundary

**Files:**
- Create: `scripts/dist-integrity.mjs`
- Create: `tests/scripts/distIntegrity.test.ts`

**Interfaces:**
- Produces `cleanDist(root: string): void`.
- Produces `inspectDistParity(root: string): { missing: string[]; orphaned: string[] }`.
- Produces `assertDistParity(root: string): void`, which throws a sorted diagnostic when either list is non-empty.

- [ ] **Step 1: Write failing isolated-filesystem tests**

```ts
expect(inspectDistParity(root)).toEqual({ missing: [], orphaned: [] });
writeFileSync(join(root, 'dist/legacy.js'), 'export {};');
expect(() => assertDistParity(root)).toThrow('orphaned output: dist/legacy.js');
cleanDist(root);
expect(existsSync(join(root, 'dist/legacy.js'))).toBe(false);
expect(existsSync(join(root, 'outside.txt'))).toBe(true);
```

- [ ] **Step 2: Run the focused test before implementation**

Run: `npx vitest run tests/scripts/distIntegrity.test.ts --minWorkers=1 --maxWorkers=4`

Expected: FAIL because `scripts/dist-integrity.mjs` does not export the requested API.

- [ ] **Step 3: Implement the minimal integrity module**

```js
export function cleanDist(root) {
  const dist = repositoryDist(root);
  rmSync(dist, { recursive: true, force: true });
}

export function inspectDistParity(root) {
  const expected = new Set([...emittedJavaScript(root), ...copiedJavaScript(root)]);
  const actual = new Set(listJavaScript(repositoryDist(root)));
  return { missing: sortedDifference(expected, actual), orphaned: sortedDifference(actual, expected) };
}
```

Validate `package.json` has name `elowen`, map TypeScript files from `src/` to `dist/`, and map copied JS/MJS/CJS assets from `plugins/` and `prompts/` into `dist/`. The CLI accepts only `clean` or `verify`.

- [ ] **Step 4: Re-run focused tests**

Run: `npx vitest run tests/scripts/distIntegrity.test.ts --minWorkers=1 --maxWorkers=4`

Expected: PASS, including missing, orphaned, copied-asset, and safe-clean cases.

- [ ] **Step 5: Commit the verified module and tests**

```bash
git add scripts/dist-integrity.mjs tests/scripts/distIntegrity.test.ts
git commit -m "test: cover deterministic dist integrity"
```

### Task 2: Wire lifecycle hooks and prove the real build is history-independent

**Files:**
- Modify: `package.json`
- Modify: `tests/scripts/distIntegrity.test.ts`

**Interfaces:**
- Consumes `cleanDist` and `assertDistParity` from Task 1.
- Produces npm scripts `prebuild`, `postbuild`, and `check:dist`.

- [ ] **Step 1: Add a failing real-build regression assertion**

```ts
writeFileSync(join(repoRoot, 'dist/cli/chat/legacy.js'), 'export {};');
const result = spawnSync('npm', ['run', 'build', '--silent'], { cwd: repoRoot, encoding: 'utf8' });
expect(result.status).toBe(0);
expect(existsSync(join(repoRoot, 'dist/cli/chat/legacy.js'))).toBe(false);
```

Use an isolated temporary fixture for pure functions; run the actual build assertion only in the real checkout and restore no source file because `dist/` is generated.

- [ ] **Step 2: Run it before wiring npm hooks**

Run: `npx vitest run tests/scripts/distIntegrity.test.ts --minWorkers=1 --maxWorkers=4`

Expected: FAIL because the existing build preserves `legacy.js`.

- [ ] **Step 3: Add lifecycle scripts**

```json
"prebuild": "node scripts/dist-integrity.mjs clean",
"build": "tsc -p tsconfig.json && cp src/store/schema.sql dist/store/ && cp -r prompts dist/ && cp -r plugins dist/",
"postbuild": "node scripts/dist-integrity.mjs verify",
"check:dist": "node scripts/dist-integrity.mjs verify"
```

- [ ] **Step 4: Verify the real build and the four known stale files**

Run: `npm run build && npm run check:dist`

Expected: PASS; `dist/cli/chat/layout.js`, `runtime.js`, `shell.js`, and `streamController.js` are absent.

- [ ] **Step 5: Commit lifecycle wiring**

```bash
git add package.json tests/scripts/distIntegrity.test.ts
git commit -m "build: clean and verify dist output"
```

### Task 3: Remove verified local dead surfaces and release-verify

**Files:**
- Modify: `src/cli/chat/streamCoordinator.ts`
- Modify: `src/cli/chat/snapshotHydrator.ts`
- Test: `tests/cli/chat/streamCoordinator.test.ts`
- Test: `tests/cli/chat/snapshotHydrator.test.ts`

**Interfaces:**
- `subagentSessions()` returns only session identifiers used by its caller.
- `SnapshotLaneLease` retains generation, current-state, status, buffering, and hydration operations; it does not expose an unused lane getter or cancellation capability.

- [ ] **Step 1: Add failing API-shape tests where a public surface would otherwise regress**

```ts
expect(Object.getOwnPropertyDescriptor(SnapshotLaneLease.prototype, 'lane')).toBeUndefined();
expect(SnapshotLaneLease.prototype.cancel).toBeUndefined();
```

- [ ] **Step 2: Run focused tests before cleanup**

Run: `npx vitest run tests/cli/chat/streamCoordinator.test.ts tests/cli/chat/snapshotHydrator.test.ts --minWorkers=1 --maxWorkers=4`

Expected: FAIL only for the new obsolete-API assertions.

- [ ] **Step 3: Remove unused computations and APIs**

```ts
const subagentSessions = (): { sessionId: string }[] =>
  subagentStates().map(({ sessionId }) => ({ sessionId }));
```

Remove `SnapshotHydrator.cancel`, `SnapshotLaneLease.lane`, and `SnapshotLaneLease.cancel` only after confirming no caller imports them.

- [ ] **Step 4: Run release gates**

Run: `npm run build && npm run check:dist && npm run deadcode && npm run depcruise && npm run lint && npm run typecheck`

Expected: all pass, no orphaned output, and no legacy chat JS modules.

- [ ] **Step 5: Commit cleanup, integrate, deploy, and smoke-test**

```bash
git add src/cli/chat/streamCoordinator.ts src/cli/chat/snapshotHydrator.ts tests/cli/chat/snapshotHydrator.test.ts
git commit -m "refactor: remove unused chat hydration APIs"
```

Cherry-pick the scoped commits into the production checkout, rebuild, run `npm run build:web` only if web files changed, restart `elowen-daemon` and `elowen-web`, and verify systemd state, daemon health, web HTTP 200, CLI version, and absent legacy files.
