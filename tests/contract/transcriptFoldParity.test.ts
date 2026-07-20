import { describe, it, expect } from 'vitest';
import { groupToolItems as daemonGroup, failureSignature as daemonSig, type ToolItem as DaemonItem } from '../../src/brain/transcript.js';
import { groupToolItems as webGroup, failureSignature as webSig, type ToolItem as WebItem } from '../../web/lib/transcript';

/** The web dock's transcript fold (web/lib/transcript.ts) is a hand-synced copy of the daemon's
 *  (src/brain/transcript.ts): a Next/Turbopack bundle can't import the daemon's NodeNext runtime source
 *  (proven — the module resolves the `./x.js` specifier to a non-existent file), so the two folds cannot
 *  share the function. This test is the guard that keeps them identical: it folds the SAME battery through
 *  both and asserts byte-equal group shapes, so any future divergence fails CI. The wire TYPES are already
 *  structurally shared via src/shared/wireContract.ts; this covers the runtime fold that can't be. */

const out = (kind: 'console' | 'result', tone: 'normal' | 'success' | 'warning' | 'danger', text: string) =>
  ({ title: 't', kind, text, tone });

// A battery exercising every fold branch: bare-run collapse, identical-failure collapse, distinct-failure
// split, and every non-collapsible kind (diff / output-success / sub / wf / command / progress).
const BATTERY: Array<Record<string, unknown>>[] = [
  // bare runs of the same tool collapse to one counted group
  [{ name: 'Read', detail: 'a.ts' }, { name: 'Read', detail: 'b.ts' }, { name: 'Read', detail: 'c.ts' }],
  // a different tool breaks the run
  [{ name: 'Read' }, { name: 'Read' }, { name: 'Grep' }, { name: 'Read' }],
  // identical failures (differ only by path/number) fold and keep members
  [{ name: 'Edit', output: out('result', 'danger', 'no such file /a/b.ts at line 4') },
   { name: 'Edit', output: out('result', 'danger', 'no such file /c/d.ts at line 9') }],
  // genuinely different failures stay separate
  [{ name: 'Edit', output: out('result', 'warning', 'permission denied') },
   { name: 'Edit', output: out('result', 'warning', 'file is read only') }],
  // console failures never fold (their output is the point)
  [{ name: 'Bash', output: out('console', 'danger', 'FAIL x\nFAIL y') },
   { name: 'Bash', output: out('console', 'danger', 'FAIL z') }],
  // non-collapsible items each keep their own group
  [{ name: 'Edit', diff: '+a' }, { name: 'Read', output: out('result', 'success', 'ok') },
   { name: 'Task', sub: { sessionId: 's', status: 'running', task: 't', tools: 0, seconds: 1 } },
   { name: 'WorkflowStart', wf: { id: 'w', toolCallId: 'c', status: 'running', nodes: [] } },
   { name: 'Bash', command: 'ls' }, { name: 'Bash', progress: 'running…' }],
  // ADJACENT SAME-NAME items each carrying a non-collapsible block — the case that actually exercises
  // isCollapsibleTool's `sub`/`diff`/`wf`/`command`/`progress` guards in the fold (a divergence on any of
  // them changes the group count here, on one fold but not the other, and this parity assertion fails).
  [{ name: 'Task', sub: { sessionId: 's1', status: 'running', task: 't', tools: 0, seconds: 1 } },
   { name: 'Task', sub: { sessionId: 's2', status: 'running', task: 't', tools: 0, seconds: 1 } }],
  [{ name: 'Edit', diff: '+a' }, { name: 'Edit', diff: '+b' }],
  [{ name: 'WorkflowStart', wf: { id: 'w1', toolCallId: 'c1', status: 'running', nodes: [] } },
   { name: 'WorkflowStart', wf: { id: 'w2', toolCallId: 'c2', status: 'running', nodes: [] } }],
  [{ name: 'Bash', command: 'ls' }, { name: 'Bash', command: 'pwd' }],
  [{ name: 'Bash', progress: 'a…' }, { name: 'Bash', progress: 'b…' }],
  [],
];

describe('daemon↔web transcript fold parity (guards the un-shareable runtime copy)', () => {
  it('groupToolItems produces identical group shapes on both sides for every battery case', () => {
    for (const items of BATTERY) {
      const d = daemonGroup(items as DaemonItem[]);
      const w = webGroup(items as WebItem[]);
      // Compare the observable shape: run length + folded members + the surviving item name/detail.
      const shape = (g: { item: { name: string; detail?: string }; count: number; members?: { name: string }[] }) =>
        ({ name: g.item.name, detail: g.item.detail, count: g.count, members: g.members?.map((m) => m.name) });
      expect(w.map(shape)).toEqual(d.map(shape));
    }
  });

  it('failureSignature agrees on both sides (the key that drives failure folding)', () => {
    const cases = [
      { name: 'Edit', output: out('result', 'danger', 'no file /x/y.ts') },
      { name: 'Edit', output: out('result', 'warning', 'denied 42 times') },
      { name: 'Bash', output: out('console', 'danger', 'boom') }, // console → undefined
      { name: 'Read', output: out('result', 'success', 'ok') },   // success → undefined
      { name: 'Read' },                                            // no output → undefined
    ];
    for (const c of cases) expect(webSig(c as WebItem)).toBe(daemonSig(c as DaemonItem));
  });
});
