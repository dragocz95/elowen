import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  CACHE_DROP_MIN_TOKENS,
  createCachePayloadMonitor,
  installCacheWatch,
  type CachePayloadMonitor,
} from '../../../src/brain/session/cacheWatch.js';
import { cacheTtlMs } from '../../../src/brain/session/toolResultClearing.js';
import { runWithPolicy } from '../../../src/plugins/policyContext.js';
import { setLogSink } from '../../../src/shared/logger.js';

const T0 = 1_000_000;
const TTL = 60_000;

interface Captured { level: string; scope: string; message: string }
let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  setLogSink({ push: (e) => { captured.push(e); } });
});
afterEach(() => setLogSink(undefined));

type Listener = (event: unknown) => void;

function harness(options: { ttlMs?: number; monitor?: CachePayloadMonitor; sessionId?: string; flavor?: 'anthropic' | 'openai-responses' } = { ttlMs: TTL }): { fire: Listener } {
  let listener: Listener = () => undefined;
  const session = { subscribe: (fn: Listener) => { listener = fn; } };
  installCacheWatch(session, options);
  return { fire: (e) => listener(e) };
}

type ProviderRequestHandler = (event: { payload: unknown }) => void;

function payloadCapture(monitor: CachePayloadMonitor): (payload: unknown) => void {
  let handler: ProviderRequestHandler = () => undefined;
  const pi = {
    on: (event: string, fn: unknown) => {
      if (event === 'before_provider_request') handler = fn as ProviderRequestHandler;
    },
  } as unknown as ExtensionAPI;
  monitor.extension(pi);
  return (payload) => handler({ payload });
}

function providerPayload(overrides: {
  system?: unknown;
  tools?: unknown[];
  messages?: unknown[];
} = {}): Record<string, unknown> {
  return {
    system: overrides.system ?? [{ type: 'text', text: 'stable system' }],
    tools: overrides.tools ?? [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }],
    messages: overrides.messages ?? [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    ],
  };
}

const assistantUsage = (cacheRead: number, timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', timestamp, usage: { cacheRead } },
});

const warnings = (): Captured[] => captured.filter((c) => c.level === 'warn' && c.scope === 'brain-cache');

/** A failed or aborted attempt: the provider was never reached, so every usage figure comes back 0. */
const failedUsage = (stopReason: 'error' | 'aborted', timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', timestamp, stopReason, usage: { cacheRead: 0 } },
});

describe('installCacheWatch — unsuccessful attempts', () => {
  // These reported cacheRead: 0 like any other message, so the watch read them as "the prefix was
  // rewritten". Reproduced from the live log: a warm read, a timeout, then the very next request reading
  // the cache back at full size — proof that nothing about the prefix had changed.
  it('ignores a timed-out attempt instead of reporting it as a cache drop', () => {
    const { fire } = harness();
    fire(assistantUsage(185_854, T0));
    fire(failedUsage('error', T0 + 19_000));
    expect(warnings()).toHaveLength(0);
  });

  it('does not let a failed attempt poison the baseline for the next comparison', () => {
    const { fire } = harness();
    fire(assistantUsage(185_854, T0));
    fire(failedUsage('error', T0 + 19_000));
    // Back to a full read. Had the failure been kept as the baseline, this RISE would reset it to a tiny
    // number and the next ordinary read would look like a fresh drop.
    fire(assistantUsage(187_990, T0 + 24_000));
    expect(warnings()).toHaveLength(0);
  });

  it('ignores an aborted attempt too', () => {
    // Five workflow children aborted within 5.4s once produced five warnings in a burst.
    const { fire } = harness();
    fire(assistantUsage(120_000, T0));
    fire(failedUsage('aborted', T0 + 3_000));
    expect(warnings()).toHaveLength(0);
  });

  it('still reports a genuine drop between two SUCCESSFUL requests', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(failedUsage('aborted', T0 + 2_000));
    fire(assistantUsage(20_000, T0 + 5_000));
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('100000 → 20000');
  });
});

describe('installCacheWatch — payload attribution', () => {
  it('identifies the changed history segment without logging its content', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const firstMessages = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'old secret output' }] },
    ];
    capture(providerPayload({ messages: firstMessages }));
    fire(assistantUsage(100_000, T0));
    capture(providerPayload({
      messages: [
        firstMessages[0],
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'new secret output' }] },
      ],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('history REWRITTEN IN PLACE at 1:user/tool_result');
    expect(warnings()[0]?.message).not.toContain('secret output');
  });

  // Live recall anchors a frozen meta message into the stream, which shifts every later index. Compared
  // position by position that reads as "the whole tail was rewritten" — the exact signal that sent this
  // investigation down the wrong path on 2026-08-04.
  it('reports a mid-history insertion as a shift rather than a rewrite', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const before = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'output' }] },
    ];
    capture(providerPayload({ messages: before }));
    fire(assistantUsage(100_000, T0));
    capture(providerPayload({
      messages: [
        before[0],
        { role: 'user', content: [{ type: 'text', text: 'recalled memory' }] },
        before[1],
        before[2],
      ],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('1 message inserted into history at 1:user');
    expect(warnings()[0]?.message).toContain('a shift, not a rewrite');
    expect(warnings()[0]?.message).not.toContain('REWRITTEN IN PLACE');
  });

  // What actually happened on 2026-08-04: ToolSearch activated five deferred tools mid-conversation.
  // The tools block sits ahead of every message, so the whole prefix re-caches.
  it('names an appended tool schema instead of reporting an anonymous change', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const first = providerPayload();
    capture(first);
    fire(assistantUsage(100_000, T0));
    const tools = Array.isArray(first.tools) ? first.tools : [];
    capture(providerPayload({
      tools: [...tools, { name: 'mcp__chrome_devtools__take_screenshot', input_schema: { type: 'object' } }],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('tools changed (1 tool appended, count 1→2)');
  });

  // Anthropic's tool search keeps `defer_loading` schemas out of the cached prefix, so the payload growing
  // by one of them cannot be what broke the cache — blaming it sends the reader after the wrong culprit.
  it('does not blame an appended DEFERRED tool for the drop', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const first = providerPayload();
    capture(first);
    fire(assistantUsage(100_000, T0));
    const tools = Array.isArray(first.tools) ? first.tools : [];
    capture(providerPayload({
      tools: [...tools, { name: 'mcp__chrome_devtools__list_pages', input_schema: { type: 'object' }, defer_loading: true }],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).not.toContain('tools changed');
    expect(warnings()[0]?.message).toContain('1 deferred tool in the payload');
    expect(warnings()[0]?.message).toContain('not the cause');
    expect(warnings()[0]?.message).toContain('likely provider eviction or routing');
  });

  it('still blames an appended UNDEFERRED tool, and reports how many are deferred', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const deferred = { name: 'mcp__chrome_devtools__list_pages', input_schema: { type: 'object' }, defer_loading: true };
    const first = providerPayload({ tools: [{ name: 'Read', input_schema: { type: 'object' } }, deferred] });
    capture(first);
    fire(assistantUsage(100_000, T0));
    const tools = Array.isArray(first.tools) ? first.tools : [];
    capture(providerPayload({ tools: [...tools, { name: 'Grep', input_schema: { type: 'object' } }] }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()[0]?.message).toContain('tools changed (1 tool appended, count 2→3, 1 deferred)');
  });

  // The moment the model CALLS a deferred tool it moves into the immediate block, which does rewrite the
  // cached prefix — the one deferred-tool transition that must stay loud.
  it('blames a deferred tool that moved into the immediate block', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const listPages = { name: 'mcp__chrome_devtools__list_pages', input_schema: { type: 'object' } };
    capture(providerPayload({
      tools: [{ name: 'Read', input_schema: { type: 'object' } }, { ...listPages, defer_loading: true }],
    }));
    fire(assistantUsage(100_000, T0));
    capture(providerPayload({
      tools: [{ name: 'Read', input_schema: { type: 'object' } }, listPages],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()[0]?.message).toContain('tools changed (segments mcp)');
  });

  it('attributes system-prompt and tool-schema changes separately', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    capture(providerPayload());
    fire(assistantUsage(100_000, T0));
    capture(providerPayload({
      system: [{ type: 'text', text: 'changed system' }],
      tools: [{ name: 'Read', description: 'Read safely', input_schema: { type: 'object', required: ['path'] } }],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('system prompt changed');
    expect(warnings()[0]?.message).toContain('tools changed (segments Read)');
  });

  it('reports likely provider eviction when the tracked payload prefix is append-only', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    const first = providerPayload();
    capture(first);
    fire(assistantUsage(100_000, T0));
    const firstMessages = first.messages;
    const messages = Array.isArray(firstMessages)
      ? [...firstMessages, { role: 'user', content: [{ type: 'text', text: 'next' }] }]
      : [];
    capture(providerPayload({ messages }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('tracked payload prefix unchanged');
    expect(warnings()[0]?.message).toContain('likely provider eviction or routing');
  });
});

describe('installCacheWatch', () => {
  it('warns when cacheRead drops sharply within a warm window', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + 10_000)); // −20k, warm
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('100000 → 80000');
  });

  it('stays silent for small drops and for growth', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(100_000 - CACHE_DROP_MIN_TOKENS + 500, T0 + 10_000)); // below the token floor
    fire(assistantUsage(120_000, T0 + 20_000)); // growth is normal
    expect(warnings()).toHaveLength(0);
  });

  it('treats a drop after a TTL-exceeding gap as expiry, not a break', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(10_000, T0 + TTL + 5_000)); // cache simply expired
    expect(warnings()).toHaveLength(0);
  });

  it('resets its baseline after a real compaction (the smaller context is by design)', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: false, result: { summary: '…' } });
    fire(assistantUsage(20_000, T0 + 10_000)); // post-compact context — no baseline, no warning
    expect(warnings()).toHaveLength(0);
    // …but a drop AFTER the new baseline warns again.
    fire(assistantUsage(15_000, T0 + 20_000));
    expect(warnings()).toHaveLength(1);
  });

  it('ignores aborted compactions, non-assistant messages and missing usage', () => {
    const { fire } = harness();
    fire(assistantUsage(100_000, T0));
    fire({ type: 'compaction_end', aborted: true }); // not a real compaction — baseline must survive
    fire({ type: 'message_end', message: { role: 'toolResult', timestamp: T0 + 5_000 } });
    fire({ type: 'message_end', message: { role: 'assistant', timestamp: T0 + 6_000 } }); // no usage
    fire(assistantUsage(80_000, T0 + 10_000));
    expect(warnings()).toHaveLength(1);
  });

  it('is a no-op without the subscribe seam', () => {
    expect(() => installCacheWatch({}, { ttlMs: TTL })).not.toThrow();
  });

  it('defaults the warm window to the env TTL MINUS a minute (boundary drops are expiry, not breaks)', () => {
    // Short retention (env unset) → TTL 5 min → warm window 4 min.
    const windowMs = cacheTtlMs(process.env) - 60_000;
    const { fire } = harness({}); // no ttlMs override — the env default drives
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + windowMs - 30_000)); // inside the window → break
    expect(warnings()).toHaveLength(1);
    // Measured against the PREVIOUS event: past the window → expiry, silent.
    fire(assistantUsage(10_000, T0 + 2 * windowMs + 30_000));
    expect(warnings()).toHaveLength(1);
  });
});

describe('installCacheWatch — warning context', () => {
  // Without the session id a log line is untraceable: this investigation once pinned a drop to the wrong
  // conversation and nearly reported a bug that did not exist.
  it('reports the session id in the warning when one is provided', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-session-42' });
    capture(providerPayload());
    fire(assistantUsage(100_000, T0));
    capture(providerPayload());
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('brain-session-42');
  });

  // The mode is only readable while the request's prompt scope is live, so it is latched into the snapshot
  // rather than read at logging time. It is reported as CONTEXT and must never be dressed up as the cause:
  // plan mode no longer narrows the tool set, so a switch leaves the cached prefix untouched, and a drop
  // across one is a REAL break. Blaming the mode would swallow the eviction hint below and aim the next
  // investigation at a change that cannot break a cache.
  it('reports a turn mode change as context while still calling the drop unexplained', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    runWithPolicy({ allowedProjectIds: new Set([1]) }, () => capture(providerPayload()), { mode: 'build' });
    fire(assistantUsage(100_000, T0));
    runWithPolicy({ allowedProjectIds: new Set([1]) }, () => capture(providerPayload()), { mode: 'plan' });
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('turn mode changed build→plan');
    expect(warnings()[0]?.message).toContain('likely provider eviction or routing');
  });

  // A snapshot taken by a request BEFORE the compaction describes a payload that no longer exists. If it
  // survived the compaction it would become the baseline for the first post-compaction comparison and the
  // next drop would be attributed to that stale request.
  it('never attributes a post-compaction drop to a pre-compaction payload snapshot', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor });
    capture(providerPayload({ system: 'pre-compaction system' }));
    fire({ type: 'compaction_end', aborted: false, result: { summary: '…' } });
    capture(providerPayload());
    fire(assistantUsage(20_000, T0 + 10_000));
    capture(providerPayload());
    fire(assistantUsage(15_000, T0 + 20_000));

    expect(warnings()).toHaveLength(1);
    // The two POST-compaction payloads are identical; only the stale pre-compaction one differs.
    expect(warnings()[0]?.message).not.toContain('system prompt changed');
    expect(warnings()[0]?.message).toContain('tracked payload prefix unchanged');
  });
});

describe('installCacheWatch — openai-responses flavor (ChatGPT backend)', () => {
  // pi-ai maps input_tokens_details.cached_tokens → usage.cacheRead for openai-codex-responses
  // (openai-responses-shared.js), so the same detector reads the same normalized field; only the payload
  // shape (instructions/input instead of system/messages) and the report wording differ.
  const responsesPayload = (overrides: { instructions?: unknown; tools?: unknown[]; input?: unknown[] } = {}): Record<string, unknown> => ({
    model: 'gpt-5.6-sol',
    instructions: overrides.instructions ?? 'stable instructions',
    tools: overrides.tools ?? [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
    input: overrides.input ?? [
      { role: 'user', content: [{ type: 'input_text', text: 'do work' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
    ],
  });

  it('attributes a warm drop on the Responses payload shape (instructions + input items)', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, flavor: 'openai-responses' });
    capture(responsesPayload());
    fire(assistantUsage(100_000, T0));
    capture(responsesPayload({
      instructions: 'changed instructions',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'do work' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"other"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      ],
    }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).toContain('system prompt changed');
    expect(warnings()[0]?.message).toContain('input items');
    expect(warnings()[0]?.message).not.toContain('content blocks');
    // Items without a role are labeled by their Responses item type.
    expect(warnings()[0]?.message).toContain('history REWRITTEN IN PLACE at 1:function_call');
  });

  it('never attributes an OpenAI drop to the Anthropic fan-out lookback', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, flavor: 'openai-responses' });
    const base = responsesPayload();
    capture(base);
    fire(assistantUsage(100_000, T0));
    // A wide fan-out step: identical prefix, dozens of appended items — on Anthropic this names the
    // lookback window, but OpenAI's prompt cache has no breakpoints, so that verdict would be a lie.
    const baseInput = Array.isArray(base.input) ? base.input : [];
    const fanned = [
      ...baseInput,
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'function_call_output', call_id: `c${i}`, output: `r${i}` })),
    ];
    capture(responsesPayload({ input: fanned }));
    fire(assistantUsage(20_000, T0 + 5_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).not.toContain('FAN-OUT MISS');
    expect(warnings()[0]?.message).toContain('OpenAI prompt caching is best-effort');
  });

  it('omits the wrote figure the chatgpt backend does not report, instead of printing "wrote 0"', () => {
    const { fire } = harness({ ttlMs: TTL, flavor: 'openai-responses' });
    fire(assistantUsage(100_000, T0));
    fire({
      type: 'message_end',
      message: { role: 'assistant', timestamp: T0 + 5_000, usage: { cacheRead: 20_000, cacheWrite: 0 } },
    });

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).not.toContain('wrote');
    // …while an actually-reported write would still be shown.
    fire({
      type: 'message_end',
      message: { role: 'assistant', timestamp: T0 + 10_000, usage: { cacheRead: 10_000, cacheWrite: 4_096 } },
    });
    expect(warnings()[1]?.message).toContain('wrote 4096');
  });

  it('defaults the warm window to the ~5-minute OpenAI retention, not the Anthropic env TTL', () => {
    const { fire } = harness({ flavor: 'openai-responses' }); // no ttlMs override
    fire(assistantUsage(100_000, T0));
    fire(assistantUsage(80_000, T0 + 3 * 60_000)); // 3 min — inside the 4-minute window → break
    expect(warnings()).toHaveLength(1);
    fire(assistantUsage(10_000, T0 + 3 * 60_000 + 4 * 60_000 + 30_000)); // past the window → expiry
    expect(warnings()).toHaveLength(1);
  });
});

describe('installCacheWatch — the cache_control marker is caching policy, not content', () => {
  const EPHEMERAL = { type: 'ephemeral', ttl: '1h' };

  /** pi-ai marks the last block of the payload's LAST user message, so every step moves the marker onto a
   *  message that did not have it before — and off the one that did. */
  const conversation = (steps: number): unknown[] => {
    const messages: unknown[] = [{ role: 'user', content: [{ type: 'text', text: 'do work' }] }];
    for (let step = 0; step < steps; step += 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `step ${step}` }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', content: `result ${step}` }] });
    }
    const last = messages[messages.length - 1] as { content: Record<string, unknown>[] };
    last.content[last.content.length - 1]!.cache_control = EPHEMERAL;
    return messages;
  };

  // The false positive this removes accused an innocent module of rewriting history and sent a whole
  // investigation the wrong way. Nothing about the conversation changes between these two requests — only
  // where pi-ai put its marker.
  it('does not call a moved marker a rewrite of already-sent history', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-1-test' });
    capture(providerPayload({ messages: conversation(1) }));
    fire(assistantUsage(300_000, T0));
    capture(providerPayload({ messages: conversation(2) }));
    fire(assistantUsage(50_000, T0 + 1_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).not.toContain('REWRITTEN IN PLACE');
  });

  // A drop with an unchanged prefix is not a shrug: when the step appended more blocks than Anthropic
  // scans back from a breakpoint, the cached segment was there and simply could not be reached. Saying so
  // is what tells the next reader which code to look at.
  it('names a fan-out miss when a wide step appended past the lookback window', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-1-test' });
    const base = conversation(1);
    capture(providerPayload({ messages: base }));
    fire(assistantUsage(347_282, T0));
    // One round of an 18-way fan-out: one assistant message plus a user message of 18 tool_result blocks.
    const fanned = [
      ...base,
      { role: 'assistant', content: Array.from({ length: 18 }, (_, i) => ({ type: 'tool_use', id: `t${i}` })) },
      {
        role: 'user',
        content: Array.from({ length: 18 }, (_, i) => ({ type: 'tool_result', content: `r${i}` })),
      },
    ];
    capture(providerPayload({ messages: fanned }));
    fire(assistantUsage(55_766, T0 + 43_000));

    const [warning] = warnings();
    expect(warning?.message).toContain('FAN-OUT MISS');
    expect(warning?.message).not.toContain('REWRITTEN IN PLACE');
  });

  // liveRecall injects a recalled-memory user message whose `content` is a bare STRING. pi-ai expands it to
  // a `[{type:'text', cache_control}]` block on the request where it is the last user message, then it
  // reverts to the string once a later step appends past it — the same text in two wire shapes. Stripping
  // cache_control alone left the shapes hashing differently, so the recall message read as "rewritten in
  // place" (reproduced from session brain-1-mrxd90yxh2rh). Folding the shapes must silence that.
  it('does not call a string↔block content shape change a rewrite', () => {
    const recallAsBlock: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'user', content: [{ type: 'text', text: 'recalled: prefer X', cache_control: EPHEMERAL }] },
    ];
    // Next request: the recall message is a bare string again and no longer last; a new step follows it.
    const recallAsString: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'user', content: 'recalled: prefer X' },
      { role: 'assistant', content: [{ type: 'text', text: 'step' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'result', cache_control: EPHEMERAL }] },
    ];
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-1-test' });
    capture(providerPayload({ messages: recallAsBlock }));
    fire(assistantUsage(240_000, T0));
    capture(providerPayload({ messages: recallAsString }));
    fire(assistantUsage(33_000, T0 + 1_000));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]?.message).not.toContain('REWRITTEN IN PLACE');
  });

  // The fold must not blind the monitor to a genuine edit: if the recalled text itself changes, that IS a
  // rewrite of an already-sent message and must still be named.
  it('still flags a genuine edit of an already-sent message', () => {
    const first: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'user', content: 'recalled: prefer X' },
    ];
    const edited: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: 'do work' }] },
      { role: 'user', content: 'recalled: prefer Y' },
      { role: 'assistant', content: [{ type: 'text', text: 'step' }] },
      { role: 'user', content: [{ type: 'tool_result', content: 'result', cache_control: EPHEMERAL }] },
    ];
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-1-test' });
    capture(providerPayload({ messages: first }));
    fire(assistantUsage(240_000, T0));
    capture(providerPayload({ messages: edited }));
    fire(assistantUsage(33_000, T0 + 1_000));

    expect(warnings()[0]?.message).toContain('REWRITTEN IN PLACE');
  });

  // Everything an investigation needs, in the record itself: which conversation, the cost, and the block
  // delta that separates a fan-out miss from a genuine rewrite.
  it('records the session, the write and the block delta', () => {
    const monitor = createCachePayloadMonitor();
    const capture = payloadCapture(monitor);
    const { fire } = harness({ ttlMs: TTL, monitor, sessionId: 'brain-1-mrxd90yxh2rh' });
    capture(providerPayload({ messages: conversation(1) }));
    fire(assistantUsage(300_000, T0));
    capture(providerPayload({ messages: conversation(2) }));
    fire({
      type: 'message_end',
      message: { role: 'assistant', timestamp: T0 + 1_000, usage: { cacheRead: 50_000, cacheWrite: 60_558 } },
    });

    const message = warnings()[0]?.message ?? '';
    expect(message).toContain('session brain-1-mrxd90yxh2rh');
    expect(message).toContain('wrote 60558');
    expect(message).toContain('content blocks');
    expect(message).toContain('lost 250000');
  });
});
