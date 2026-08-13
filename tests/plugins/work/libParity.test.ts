import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The work plugin is its own compile unit (plugins/work/dist) and cannot runtime-import the daemon's
// src/ modules, so the task-routes extraction COPIED the one pure core utility they need. The core
// twin is still live (the plugin marketplace serialises its installs with it), so both sides run in
// production — this pins the pair that must not drift, exactly like the agents plugin's own
// tests/plugins/agents/libParity.test.ts.
// keyedMutex serialises the per-checkout git critical section: with the agents plugin loaded the work
// routes borrow ITS lock instance, and only fall back to this copy when that plugin is off. A
// one-sided fix to the queueing would make the fallback interleave differently from the real thing.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PINNED: [core: string, copy: string][] = [
  ['src/shared/keyedMutex.ts', 'plugins/work/src/lib/keyedMutex.ts'],
];

describe('work plugin lib copies stay in lockstep with core', () => {
  for (const [core, copy] of PINNED) {
    it(`${copy} is byte-identical to ${core}`, () => {
      expect(readFileSync(resolve(root, copy), 'utf8')).toBe(readFileSync(resolve(root, core), 'utf8'));
    });
  }
});
