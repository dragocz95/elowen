import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The agents plugin is its own compile unit (dist/plugins/agents/dist) and cannot runtime-import the
// daemon's src/ modules, so extraction B1 COPIED the small pure core utilities it needs into
// plugins/agents/src/lib. Until step 8 deletes the core subsystem, both copies are live — this test
// pins the ones that must not drift byte-for-byte (pattern: tests/contract/cronParity.test.ts).
// execs.ts is the critical one: the program/exec grammar feeds routing, resume and usage attribution
// on BOTH sides, and a one-sided change would split how core and plugin parse the same exec label.
// The other lib copies either deliberately deviate (logger inlines logDir; tdd/mcpArgs/owner/
// uniqueName/text/textHash/time/clock/keyedMutex are tiny and judged low-risk) and are not pinned.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PINNED: [core: string, copy: string][] = [
  ['src/shared/execs.ts', 'plugins/agents/src/lib/execs.ts'],
];

describe('agents plugin lib copies stay in lockstep with core (extraction B1)', () => {
  for (const [core, copy] of PINNED) {
    it(`${copy} is byte-identical to ${core}`, () => {
      expect(readFileSync(resolve(root, copy), 'utf8')).toBe(readFileSync(resolve(root, core), 'utf8'));
    });
  }
});
