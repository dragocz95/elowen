import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The agents plugin is its own compile unit (dist/plugins/agents/dist) and cannot runtime-import the
// daemon's src/ modules, so extraction B1 COPIED the small pure core utilities it needs into
// plugins/agents/src. While the core twins are still live (plugin-less wiring: tests, plugin
// disabled), both sides run in production-shaped setups — this test pins the pairs that must not
// drift (pattern: tests/contract/cronParity.test.ts).
// execs.ts is the critical one: the program/exec grammar feeds routing, resume and usage attribution
// on BOTH sides, and a one-sided change would split how core and plugin parse the same exec label.
// keyedMutex serialises the git/worktree critical sections on both sides — a one-sided fix to its
// queueing would let the two halves interleave differently around the same repos.
// The other lib copies are tiny and judged low-risk (tdd/mcpArgs/owner/uniqueName/text/textHash/
// time/clock) and are not pinned. lib/logger.ts is no copy at all anymore — it delegates
// to the host's plugin logger (F4), so there is nothing to keep in lockstep.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PINNED: [core: string, copy: string][] = [
  ['src/shared/execs.ts', 'plugins/agents/src/lib/execs.ts'],
  ['src/shared/keyedMutex.ts', 'plugins/agents/src/lib/keyedMutex.ts'],
];

describe('agents plugin lib copies stay in lockstep with core (extraction B1)', () => {
  for (const [core, copy] of PINNED) {
    it(`${copy} is byte-identical to ${core}`, () => {
      expect(readFileSync(resolve(root, copy), 'utf8')).toBe(readFileSync(resolve(root, core), 'utf8'));
    });
  }
});

// PlanJobStore exists TWICE by design: the plugin's overseer runtime owns the live instance, while
// the core RouteContext keeps a local fallback for plugin-less wiring (the /tasks/plan skeleton works
// without the plugin). The two copies legitimately differ in their import specifiers (different
// compile units) but must not drift in LOGIC — a one-sided change to job settling would make the
// fallback behave differently from the real thing. Compared after normalizing module specifiers and
// the one singular/plural comment word the copies differ in. (The DecisionQueue pair is gone: the
// review gate moved into the plugin and the core fallback queue was deleted with it.)
const NORMALIZED: [core: string, copy: string][] = [
  ['src/api/planJobStore.ts', 'plugins/agents/src/overseer/planJob.ts'],
];

const normalize = (src: string): string => src
  .replace(/from '[^']+'/g, "from 'X'")
  .replace(/definitions live/g, 'definition lives')
  .replace(/existing imports/g, 'plugin-internal imports');

describe('core fallback stores stay in logical lockstep with the plugin originals', () => {
  for (const [core, copy] of NORMALIZED) {
    it(`${core} matches ${copy} modulo import paths`, () => {
      expect(normalize(readFileSync(resolve(root, core), 'utf8'))).toBe(normalize(readFileSync(resolve(root, copy), 'utf8')));
    });
  }
});
