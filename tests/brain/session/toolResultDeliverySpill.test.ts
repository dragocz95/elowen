import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { setSpillNamespaceResolver, toolResultSpillDir } from '../../../src/shared/paths.js';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import {
  CLEARED_TOOL_RESULT_DETAIL,
  CLEAR_MIN_BYTES,
  SPILL_MAX_RESULT_BYTES,
  TOOL_RESULT_GROUP_BUDGET_BYTES,
  decideDeliverySpill,
  installToolResultDeliverySpill,
  isClearedToolResult,
} from '../../../src/brain/session/toolResultClearing.js';
import { providerPayloadHarness } from '../../helpers/providerPayloads.js';

/** Size and group spilling decided at DELIVERY, before PI builds the tool-result message.
 *
 *  The point of the move is that nothing is ever rewritten: the placeholder exists before
 *  `createToolResultMessage`, so the stored row, the agent state, the live UI event and the end-of-run
 *  re-persist all carry it, and the content reaches the provider as a placeholder the FIRST time rather
 *  than replacing bytes it has already cached.
 *
 *  RED BEFORE THE CHANGE: `installToolResultDeliverySpill` did not exist and the egress transform decided
 *  both triggers, so `session.messages` and the `message_end` event carried the full output and only the
 *  provider payload was ever shortened. */

const DIR = '/tmp/delivery-spill/sess-1';
let dirs: string[] = [];
afterEach(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); dirs = []; });

const text = (size: number, fill = 'x'): [{ type: 'text'; text: string }] => [{ type: 'text', text: fill.repeat(size) }];

describe('decideDeliverySpill', () => {
  it('leaves a result that is neither oversized nor over budget, and charges its real size', () => {
    const decision = decideDeliverySpill(0, DIR, 'c1', text(10_000));
    expect(decision.spill).toBeNull();
    expect(decision.wireBytes).toBe(10_000);
  });

  it('spills a single result above the per-result trigger, with a bounded preview', () => {
    const decision = decideDeliverySpill(0, DIR, 'c1', text(SPILL_MAX_RESULT_BYTES + 1, 'z'));
    expect(decision.spill?.trigger).toBe('size');
    expect(decision.spill?.path).toBe(`${DIR}/c1.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`);
    expect(decision.spill?.placeholder).toContain('saved to disk instead of the context');
    expect(decision.spill?.text.length).toBe(SPILL_MAX_RESULT_BYTES + 1);
    expect(decision.wireBytes).toBeLessThan(CLEAR_MIN_BYTES);
  });

  it('does not spill a result exactly at the per-result threshold', () => {
    expect(decideDeliverySpill(0, DIR, 'c1', text(SPILL_MAX_RESULT_BYTES)).spill).toBeNull();
  });

  /** The floor the review refused: with a lower size bound on the group decision, a batch of many small
   *  results has no eligible candidate at all and overruns the budget without any limit. */
  it('has no lower size bound on the group decision', () => {
    const committed = TOOL_RESULT_GROUP_BUDGET_BYTES - 100;
    const decision = decideDeliverySpill(committed, DIR, 'c1', text(200));
    expect(decision.spill?.trigger).toBe('group');
  });

  it('keeps a whole batch of small results inside the budget', () => {
    let committed = 0;
    let spilled = 0;
    for (let index = 0; index < 80; index += 1) {
      const decision = decideDeliverySpill(committed, DIR, `c${index}`, text(3_900));
      if (decision.spill) spilled += 1;
      committed += decision.wireBytes;
    }
    // 80 x 3900 = 312 000 bytes of output against a 200 000 budget: without spilling this cannot fit.
    expect(spilled).toBeGreaterThan(0);
    expect(committed).toBeLessThanOrEqual(TOOL_RESULT_GROUP_BUDGET_BYTES + spilled * CLEAR_MIN_BYTES);
  });

  it('can only ever count a result with no tool call id, never spill it', () => {
    const decision = decideDeliverySpill(TOOL_RESULT_GROUP_BUDGET_BYTES, DIR, '', text(50_000));
    expect(decision.spill).toBeNull();
    expect(decision.wireBytes).toBe(50_000);
  });

  it('measures only text blocks, as the spill file holds only text', () => {
    const content = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, ...text(10)] as never;
    expect(decideDeliverySpill(0, DIR, 'c1', content).wireBytes).toBe(10);
  });
});

describe('the afterToolCall wrapper', () => {
  const input = (content: unknown): never => ({
    assistantMessage: { role: 'assistant', content: [] },
    toolCall: { id: 'c1', name: 'Big', arguments: {} },
    args: {},
    result: { content, details: { exitCode: 0 } },
    isError: false,
    context: {},
  }) as never;

  /** PI replaces the WHOLE tool result with an error string when `afterToolCall` throws, so a failing
   *  spill would not merely leave the output unspilled — it would destroy it. */
  it('never throws, whatever the decision does', async () => {
    const session = { agent: { afterToolCall: async () => ({ content: text(10) }) } } as never;
    installToolResultDeliverySpill(session, 'sess-1', {
      spillDir: DIR,
      writeSpill: async () => { throw new Error('ENOSPC'); },
    });
    const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<unknown> } }).agent.afterToolCall;
    // A content array whose length getter throws takes the decision itself down, not just the write.
    const hostile = new Proxy([], { get: (target, key) => { if (key === 'length') throw new Error('boom'); return Reflect.get(target, key); } });
    await expect(hook(input(hostile))).resolves.toEqual({ content: text(10) });
  });

  it('sends the full result when the spill cannot be stored', async () => {
    const session = { agent: {} } as never;
    installToolResultDeliverySpill(session, 'sess-1', {
      spillDir: DIR,
      writeSpill: async () => { throw Object.assign(new Error('readonly'), { code: 'EACCES' }); },
    });
    const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<unknown> } }).agent.afterToolCall;
    const full = text(SPILL_MAX_RESULT_BYTES + 1);
    expect(await hook(input(full))).toBeUndefined(); // undefined = PI keeps the executed result untouched
  });

  it('adopts an identical file already at the spill path instead of losing the result', async () => {
    const session = { agent: {} } as never;
    const full = text(SPILL_MAX_RESULT_BYTES + 1, 'q');
    installToolResultDeliverySpill(session, 'sess-1', {
      spillDir: DIR,
      writeSpill: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      readSpill: async () => full[0].text,
    });
    const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<{ content: { text: string }[] } | undefined> } }).agent.afterToolCall;
    const out = await hook(input(full));
    expect(out?.content[0]?.text).toContain('saved to disk instead of the context');
  });

  it('is a no-op on a session without the agent seam', () => {
    expect(() => installToolResultDeliverySpill({}, 'sess-1')).not.toThrow();
  });
});

describe('the spill directory in production wiring', () => {
  it('writes into the session’s immutable namespace, which the existing cleanup sweeps', async () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-delivery-ns-'));
    dirs.push(home);
    vi.stubEnv('HOME', home);
    try {
      // The store mints the conversation's immutable spill namespace, the resolver (exactly what
      // buildBrainCore installs) hands it to the module's default spill dir, and the store's delete sweeps
      // the SAME directory — so re-keying the session id can never separate the files from their owner.
      const store = new BrainStore(openDb(':memory:'));
      store.createSession({ id: 'sess-fs', userId: 7, model: 'm' });
      setSpillNamespaceResolver((id) => store.spillNamespace(id));
      const session = { agent: {} } as never;
      installToolResultDeliverySpill(session, 'sess-fs');
      const hook = (session as { agent: { afterToolCall: (i: unknown) => Promise<{ content: { text: string }[] } | undefined> } }).agent.afterToolCall;
      const out = await hook({
        assistantMessage: { role: 'assistant', content: [] },
        toolCall: { id: 'fresh', name: 'Big', arguments: {} },
        args: {}, isError: false, context: {},
        result: { content: text(SPILL_MAX_RESULT_BYTES + 1, 'z'), details: {} },
      });
      const spilled = /Full output at: (\S+) — read it/.exec(out?.content[0]?.text ?? '')?.[1];
      expect(spilled).toBe(join(
        toolResultSpillDir(process.env, store.spillNamespace('sess-fs')),
        `fresh.v1-preview-${SPILL_MAX_RESULT_BYTES + 1}.txt`,
      ));
      expect(readFileSync(spilled!, 'utf8').length).toBe(SPILL_MAX_RESULT_BYTES + 1);

      store.deleteSession('sess-fs');
      expect(existsSync(spilled!)).toBe(false);
    } finally {
      setSpillNamespaceResolver(undefined);
      vi.unstubAllEnvs();
    }
  });
});

describe('a real session delivering an oversized tool result', () => {
  const OUTPUT = `HEAD-${'z'.repeat(60_000)}-TAIL`;

  it('puts the placeholder in the message, the event and the next request, and the output on disk', async () => {
    const spillDir = mkdtempSync(join(tmpdir(), 'elowen-delivery-spill-'));
    dirs.push(spillDir);
    const harness = await providerPayloadHarness({
      toolNames: ['Big'],
      customTools: [defineTool({
        name: 'Big', label: 'Big', description: 'Returns a large output',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: OUTPUT }], details: { command: 'big' } }),
      })],
      replyFor: (call) => (call === 1 ? [{ type: 'toolCall', id: 'call-1', name: 'Big', arguments: {} }] : undefined),
    });
    installToolResultDeliverySpill(harness.session, 'sess-1', { spillDir });
    const ended: { role?: string; content?: { text?: string }[]; details?: unknown }[] = [];
    harness.session.subscribe(((event: { type: string; message?: unknown }) => {
      if (event.type === 'message_end') ended.push(event.message as never);
    }) as never);

    const payloads = await harness.prompt('go');

    const spillPath = join(spillDir, `call-1.v1-preview-${OUTPUT.length}.txt`);
    expect(readFileSync(spillPath, 'utf8')).toBe(OUTPUT); // the FULL output, tail included

    // The live message PI appended to its own state — the object persistence projects the row from.
    const result = harness.session.messages.find((m) => (m as { role?: string }).role === 'toolResult') as {
      content: { text: string }[]; details: Record<string, unknown>;
    };
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain(spillPath);
    expect(result.content[0]!.text).toContain('HEAD-zzz');
    expect(result.content[0]!.text).not.toContain('-TAIL');
    // The tool's own details survive beside the marker, so a diff or a shared image still renders.
    expect(result.details.command).toBe('big');
    expect(isClearedToolResult(result)).toBe(true);
    expect(result.details[CLEARED_TOOL_RESULT_DETAIL]).toEqual({ mode: 'preview', bytes: OUTPUT.length, path: spillPath });

    // The message_end event carries the same bytes — that event is what writes the pending row.
    const endedResult = ended.find((m) => m.role === 'toolResult');
    expect(endedResult?.content?.[0]?.text).toBe(result.content[0]!.text);

    // …and so does the request that follows, which is the first time these bytes reach the provider.
    const second = payloads[1];
    expect(JSON.stringify(second)).not.toContain('-TAIL');
    expect(JSON.stringify(second)).toContain('saved to disk instead of the context');
  });
});
