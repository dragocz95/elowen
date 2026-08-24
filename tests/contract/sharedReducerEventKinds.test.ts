import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UNRENDERED_EVENT_KINDS } from '../../packages/plugin-shared/liveMessage.mjs';

/** Every `BrainEvent` kind the core can emit must have an ANSWER in the shared chat reducer
 *  (packages/plugin-shared/liveMessage.mjs) — either a branch in `onEvent` that renders it, or a place in
 *  that module's `UNRENDERED_EVENT_KINDS` list saying why it is inert on a chat surface.
 *
 *  This exists because the failure mode has no symptom. `file` and `ask_resolved` were both added to the
 *  union, wired through the CLI and the web, and simply had no branch here: the agent announced a file,
 *  ShareFile reported success, and the person in the room received nothing at all. Nothing crashed and no
 *  test went red. So the list is DERIVED from the union in src/brain/events.ts rather than hand-written —
 *  a hand-written inventory is the same silence one indirection further away. */
describe('shared chat reducer covers every BrainEvent kind', () => {
  const root = resolve(__dirname, '../..');

  /** The kind tags of the `BrainEvent` union, read out of its declaration. Bounded to the union body so
   *  the payload interfaces below it (which carry their own `type:` fields) cannot inflate the list. */
  const unionKinds = (): string[] => {
    const source = readFileSync(resolve(root, 'src/brain/events.ts'), 'utf8');
    const start = source.indexOf('export type BrainEvent =');
    expect(start).toBeGreaterThan(0);
    const end = source.indexOf("| { type: 'error'; message: string };", start);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end + 40);
    const kinds = [...body.matchAll(/\btype: '([a-z_-]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(20); // the union really was parsed, not silently missed
    return [...new Set(kinds)];
  };

  /** The kinds the reducer actually branches on, read out of its `onEvent` comparisons. */
  const handledKinds = (): string[] => {
    const source = readFileSync(resolve(root, 'packages/plugin-shared/liveMessage.mjs'), 'utf8');
    const kinds = [...source.matchAll(/e\.type === '([a-z_-]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(10);
    return [...new Set(kinds)];
  };

  it('classifies every kind as either rendered or explicitly unrendered', () => {
    const answered = new Set([...handledKinds(), ...UNRENDERED_EVENT_KINDS]);
    const unclassified = unionKinds().filter((kind) => !answered.has(kind));
    expect(unclassified).toEqual([]);
  });

  it('renders the two kinds whose absence was the original silent gap', () => {
    const handled = handledKinds();
    expect(handled).toContain('file');
    expect(handled).toContain('ask_resolved');
  });

  it('keeps UNRENDERED_EVENT_KINDS honest — nothing listed there is also branched on, nothing is stale', () => {
    const handled = new Set(handledKinds());
    const union = new Set(unionKinds());
    for (const kind of UNRENDERED_EVENT_KINDS) {
      expect(handled.has(kind), `${kind} is both branched on and declared unrendered`).toBe(false);
      expect(union.has(kind), `${kind} is declared unrendered but is not a BrainEvent kind`).toBe(true);
    }
  });
});
