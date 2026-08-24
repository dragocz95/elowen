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

  /** Any kind tag a `type:` position can hold. Deliberately wider than the kinds that exist today: a
   *  future `tool_v2` or `askResolved` must not silently drop out of the inventory and take its missing
   *  reducer branch with it — which is the whole failure mode this file exists to catch. */
  const KIND_TAG = "([A-Za-z0-9_-]+)";

  /** TypeScript comments, removed before the union body is located. A brace or a semicolon inside prose
   *  would otherwise unbalance the scan below, and a `type: 'x'` quoted in a doc comment would be read as
   *  a real member. Block comments go first so a `//` inside one cannot be mistaken for a line comment. */
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  /** The kind tags of the `BrainEvent` union, read out of its declaration. Bounded to the union body so
   *  the payload interfaces below it (which carry their own `type:` fields) cannot inflate the list.
   *
   *  The bound is found by walking to the semicolon that CLOSES the alias, tracking brace depth — every
   *  `{ type: 'x'; … }` member contains semicolons of its own, so the first one is not the end. This used
   *  to key on the literal text of the union's last member instead, which meant reformatting that one
   *  line, adding a doc comment above it, or moving `error` off the end silently yielded an empty parse. */
  const parseUnionKinds = (source: string): string[] => {
    const start = source.indexOf('export type BrainEvent =');
    if (start < 0) throw new Error('the BrainEvent union declaration was not found');
    const tail = stripComments(source.slice(start));
    let depth = 0;
    let end = -1;
    for (let i = 0; i < tail.length; i += 1) {
      const ch = tail[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === ';' && depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('the BrainEvent union declaration is not terminated');
    const kinds = [...tail.slice(0, end).matchAll(new RegExp(`\\btype: '${KIND_TAG}'`, 'g'))].map((m) => m[1]!);
    return [...new Set(kinds)];
  };

  const unionKinds = (): string[] => {
    const kinds = parseUnionKinds(readFileSync(resolve(root, 'src/brain/events.ts'), 'utf8'));
    expect(kinds.length).toBeGreaterThan(20); // the union really was parsed, not silently missed
    return kinds;
  };

  /** The kinds the reducer actually branches on, read out of its `onEvent` comparisons. */
  const handledKinds = (): string[] => {
    const source = readFileSync(resolve(root, 'packages/plugin-shared/liveMessage.mjs'), 'utf8');
    const kinds = [...source.matchAll(new RegExp(`e\\.type === '${KIND_TAG}'`, 'g'))].map((m) => m[1]!);
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

  /** The parse is the whole contract, so it has to survive ordinary edits to `events.ts`. It used to bound
   *  the union on the exact literal `| { type: 'error'; message: string };` and to match kinds with
   *  `[a-z_-]+`, which meant reformatting that one line, putting a doc comment above it, moving `error` off
   *  the end, or adding a kind with a digit or a capital silently shrank the inventory — and a kind missing
   *  from the inventory is a kind whose absent reducer branch nobody is told about. */
  it('survives the edits to events.ts that used to make the inventory silently wrong', () => {
    const kinds = parseUnionKinds(`
export type BrainEvent =
  /** A doc comment with braces { } and a semicolon; and a // slash, none of which may end the scan. */
  | {
      type: 'error';
      message: string;
    }
  | { type: 'text'; delta: string }
  | { type: 'tool_v2'; name: string }
  | { type: 'askResolved'; id: string }
  | { type: 'idle' };

// Payload interfaces below the alias carry their own \`type:\` fields and must NOT inflate the list.
export interface ToolOutputView { type: 'not-an-event'; text: string }
`);
    expect(kinds).toEqual(['error', 'text', 'tool_v2', 'askResolved', 'idle']);
  });

  it('fails loudly rather than reporting an empty inventory when the union cannot be located', () => {
    expect(() => parseUnionKinds('export type Something = never;')).toThrow(/was not found/);
    expect(() => parseUnionKinds("export type BrainEvent =\n  | { type: 'text' }")).toThrow(/not terminated/);
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
