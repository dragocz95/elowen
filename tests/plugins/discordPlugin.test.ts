import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('discord plugin', () => {
  it('registers no platform without a botToken (warns instead of crashing)', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['discord'], logger: log });
    expect(reg.platforms).toHaveLength(0);
  });

  it('registers the platform adapter when a botToken is configured', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['discord'], logger: log,
      config: { discord: { botToken: 'tok', rolePolicies: [] } },
    });
    expect(reg.platforms.map((p) => p.name)).toEqual(['discord']);
  });
});

describe('discord splitContent (code-block-aware chunking)', () => {
  it('never breaks a fenced code block across a chunk boundary', async () => {
    const { splitContent } = await import(join(repoRoot, 'plugins/discord/index.mjs')) as { splitContent: (t: string) => string[] };
    const big = '```js\n' + 'const x = 1;\n'.repeat(400) + '```'; // > 2000 chars, one fence
    const pieces = splitContent(big);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(2100);
      expect((p.match(/```/g)?.length ?? 0) % 2).toBe(0); // every piece has balanced fences
    }
    // reassembled (stripping the injected reopen/close fences) preserves the code lines
    expect(pieces.join('')).toContain('const x = 1;');
  });

  it('leaves short text untouched', async () => {
    const { splitContent } = await import(join(repoRoot, 'plugins/discord/index.mjs')) as { splitContent: (t: string) => string[] };
    expect(splitContent('ahoj')).toEqual(['ahoj']);
  });
});

describe('discord LiveMessage (tool progress)', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
    LiveMessage: new (adapter: { rest: (m: string, p: string, b: { content: string }) => Promise<{ id: string }> }, channelId: string) => {
      onEvent: (e: { type: string; name?: string; detail?: string; delta?: string }) => void;
      finalize: (reply?: string) => Promise<void>;
    };
  };

  it('tools stack tightly in the progress bubble; a narration-first answer is re-anchored BELOW the trace', async () => {
    const { LiveMessage } = await load();
    const posts: string[] = []; // message ids in creation order
    const edits = new Map<string, string>();
    const deleted: string[] = [];
    let nextId = 0;
    const adapter = {
      cfg: { answerMode: 'live' },
      rest: async (method: string, path: string, body: { content: string }) => {
        if (method === 'POST') { const id = `m${++nextId}`; posts.push(id); edits.set(id, body.content); return { id }; }
        const id = path.split('/').pop()!;
        if (method === 'DELETE') { deleted.push(id); return { id }; }
        edits.set(id, body.content);
        return { id };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'text', delta: 'Mrknu na to… ' }); // pre-tool narration opens the answer bubble FIRST (m1)
    lm.onEvent({ type: 'tool', name: 'run_command', detail: 'apt list --upgradable', icon: '💻' }); // tool bubble posts below (m2)
    lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' });
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('Hotovo, vše běží.');
    // Bubbles created in order: [stranded draft m1, tool trace m2, re-anchored answer m3].
    const [draftId, progressId, finalId] = posts;
    expect(deleted).toContain(draftId); // the draft stranded ABOVE the trace is deleted, not left buried in scrollback
    expect(edits.get(progressId)).toBe('💻 `run_command`: "apt list --upgradable"\n📄 `read_file`'); // single \n = tight; finalize closes every row
    expect(edits.get(progressId)).not.toContain('\n\n');
    expect(edits.get(finalId)).toBe('Hotovo, vše běží.'); // final answer re-posted BELOW the trace, as the LAST message
  });

  it('summary mode (cfg.streamAnswer=false): tools stream live, the answer posts once at the end', async () => {
    const { LiveMessage } = await load();
    const posts: { id: string; content: string }[] = [];
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = {
      cfg: { streamAnswer: false },
      rest: async (method: string, path: string, body: { content: string }) => {
        if (method === 'POST') { const id = `m${++nextId}`; posts.push({ id, content: body.content }); edits.set(id, body.content); return { id }; }
        const id = path.split('/').pop()!;
        edits.set(id, body.content);
        return { id };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'text', delta: 'Koukám se na to, hned…' }); // narration is NOT streamed live in summary mode
    lm.onEvent({ type: 'tool', name: 'run_command', detail: 'npm test', icon: '💻' }); // the tool trace DOES stream (m1)
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('Hotovo — vše zelené.');
    // Exactly two messages: the live tool trace and the single final summary — no intermediate answer bubble.
    expect(posts).toHaveLength(2);
    expect(edits.get(posts[0]!.id)).toContain('run_command'); // tool trace streamed live
    expect(posts[1]!.content).toContain('Hotovo — vše zelené.'); // the summary posted once, below the trace
    expect(posts.some((p) => p.content.includes('Koukám se na to'))).toBe(false); // narration never became its own message
  });

  it('tracks a live command by id: running tail → completed summary, while answerMode=final posts once', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const posts: string[] = [];
      const edits = new Map<string, string>();
      let nextId = 0;
      const adapter = { cfg: {}, rest: async (method: string, path: string, body: { content: string }) => {
        const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
        if (method === 'POST') posts.push(id);
        edits.set(id, body.content);
        return { id };
      } };
      const lm = new LiveMessage(adapter, 'chan', 'trigger', 'user', { toolActivity: 'live', answerMode: 'final', toolOutput: 'tail' });
      lm.onEvent({ type: 'text', delta: 'working narration' });
      lm.onEvent({ type: 'tool', id: 'cmd1', name: 'run_command', detail: 'npm test', icon: '💻' });
      await vi.advanceTimersByTimeAsync(0);
      expect(edits.get('m1')).toContain('💻 `run_command`');
      expect(posts).toEqual(['m1']); // no answer draft in final mode

      lm.onEvent({ type: 'tool_progress', id: 'cmd1', text: 'PASS a.test\nPASS b.test' });
      await vi.advanceTimersByTimeAsync(1200);
      expect(edits.get('m1')).toContain('> PASS b.test');

      lm.onEvent({ type: 'tool_output', id: 'cmd1', output: { title: 'console output', kind: 'console', text: '44 tests passed', status: 'exit 0', tone: 'success' } });
      await lm.finalize('Hotovo.');
      expect(edits.get('m1')).toContain('💻 `run_command`');
      expect(edits.get('m1')).toContain('44 tests passed');
      expect(posts).toEqual(['m1', 'm2']);
      expect(edits.get('m2')).toContain('Hotovo.');
    } finally { vi.useRealTimers(); }
  });

  it('updates parallel tool rows by toolCallId and preserves independent success/error states', async () => {
    const { LiveMessage } = await load();
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = { cfg: {}, rest: async (method: string, path: string, body: { content: string }) => {
      const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
      edits.set(id, body.content); return { id };
    } };
    const lm = new LiveMessage(adapter, 'chan', undefined, undefined, { toolActivity: 'status', answerMode: 'final', toolOutput: 'summary' });
    lm.onEvent({ type: 'tool', id: 'a', name: 'read_file', detail: 'a.ts', icon: '📄' });
    lm.onEvent({ type: 'tool', id: 'b', name: 'run_command', detail: 'npm test', icon: '💻' });
    lm.onEvent({ type: 'tool_output', id: 'b', output: { title: 'console output', kind: 'console', text: 'Test failed', status: 'exit 1', tone: 'warning' } });
    lm.onEvent({ type: 'tool_end', id: 'a' });
    await lm.finalize('Opravil jsem chybu.');
    expect(edits.get('m1')).toContain('📄 `read_file`: "a.ts"');
    expect(edits.get('m1')).toContain('💻 `run_command`: "npm test" — exit 1');
  });

  it('bounds a long trace around the newest tools and neutralizes mentions from tool data', async () => {
    const { LiveMessage } = await load();
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = { cfg: {}, rest: async (method: string, path: string, body: { content: string }) => {
      const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
      edits.set(id, body.content); return { id };
    } };
    const lm = new LiveMessage(adapter, 'chan', undefined, undefined, { toolActivity: 'live', answerMode: 'final', toolOutput: 'tail' });
    for (let i = 0; i < 140; i++) lm.onEvent({ type: 'tool', id: `t${i}`, name: `tool_${i}`, detail: i === 139 ? '@everyone <@123>' : `item ${i}` });
    lm.onEvent({ type: 'tool_progress', id: 't139', text: '@here still running' });
    lm.onEvent({ type: 'tool_output', id: 't139', output: { title: 'tool result', kind: 'result', text: '@here done', tone: 'success' } });
    await lm.finalize('done');
    const trace = edits.get('m1')!;
    expect(trace.length).toBeLessThanOrEqual(1990);
    expect(trace).toContain('tool_139');
    expect(trace).not.toContain('tool_0`');
    expect(trace).not.toContain('@everyone');
    expect(trace).not.toContain('<@123>');
    expect(trace).not.toContain('@here');
  });

  it('a turn without tools posts only the answer', async () => {
    const { LiveMessage } = await load();
    const posts: string[] = [];
    const adapter = { rest: async (_m: string, _p: string, body: { content: string }) => { posts.push(body.content); return { id: `m${posts.length}` }; } };
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'text', delta: 'Jen odpověď.' });
    await lm.finalize('Jen odpověď.');
    expect(posts).toEqual(['Jen odpověď.']);
  });

  it('consecutive repeats of one tool collapse into a ×N counter with the latest detail', async () => {
    const { LiveMessage } = await load();
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = {
      rest: async (method: string, path: string, body: { content: string }) => {
        const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
        edits.set(id, body.content);
        return { id };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    // The icon now rides the tool event (daemon resolves it from the core map + plugin manifest icons);
    // the progress line renders event.icon and falls back to the generic wrench when absent.
    lm.onEvent({ type: 'tool', name: 'sarah_hair', detail: 'list_services', icon: '✂️' });
    lm.onEvent({ type: 'tool', name: 'sarah_hair', detail: 'list_bookings', icon: '✂️' });
    lm.onEvent({ type: 'tool', name: 'sarah_hair', icon: '✂️' }); // detail-less repeat keeps the latest detail
    lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' });  // different tool → new line
    lm.onEvent({ type: 'tool', name: 'sarah_hair', icon: '✂️' }); // NON-consecutive → a fresh line, no merge back
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('done');
    expect(edits.get('m1')).toBe('✂️ `sarah_hair`: "list_bookings" ×3\n📄 `read_file`\n✂️ `sarah_hair`');
  });

  it('renders a ctx.emitCard card in the progress bubble; an empty card removes it', async () => {
    const { LiveMessage } = await load();
    const mk = () => {
      const edits = new Map<string, string>();
      let nextId = 0;
      const adapter = { rest: async (method: string, path: string, body: { content: string }) => {
        const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
        edits.set(id, body.content); return { id };
      } };
      return { edits, adapter };
    };
    // Present: a tool line + a card → the settled bubble (flushed on finalize) carries the card.
    const a = mk();
    const lmA = new LiveMessage(a.adapter, 'chan');
    lmA.onEvent({ type: 'tool', name: 'todo_write', icon: '📋' });
    lmA.onEvent({ type: 'card', card: { id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'Alpha', status: 'completed' }, { text: 'Beta', status: 'in_progress' }] } });
    await new Promise((r) => setTimeout(r, 20));
    await lmA.finalize('done');
    const bubbleA = a.edits.get('m1')!;
    expect(bubbleA).toContain('📋 **Todos** (1/2)');
    expect(bubbleA).toContain('~~Alpha~~'); // completed struck through
    expect(bubbleA).toContain('🔸 Beta');   // in-progress
    // Remove: a later empty card (no items/body) drops it from the settled bubble.
    const b = mk();
    const lmB = new LiveMessage(b.adapter, 'chan');
    lmB.onEvent({ type: 'tool', name: 'todo_write', icon: '📋' });
    lmB.onEvent({ type: 'card', card: { id: 'todos', title: 'Todos', pinned: true, items: [{ text: 'Alpha' }] } });
    lmB.onEvent({ type: 'card', card: { id: 'todos', items: [] } });
    await new Promise((r) => setTimeout(r, 20));
    await lmB.finalize('done');
    expect(b.edits.get('m1')!).not.toContain('Todos');
  });

  it('the idle event yields a runtime footer under the final answer (opt-out via config)', async () => {
    const { LiveMessage, footerLine } = (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
      LiveMessage: new (adapter: unknown, channelId: string) => { onEvent: (e: unknown) => void; finalize: (reply?: string) => Promise<void> };
      footerLine: (idle: unknown) => string;
    };
    // Unit: provider prefix dropped, percent rounded, missing data → no fragment / empty line.
    expect(footerLine({ model: 'anthropic/claude-sonnet-5', usage: { percent: 41.6 } })).toBe('-# claude-sonnet-5 · 42 %');
    expect(footerLine({ model: 'gpt-5' })).toBe('-# gpt-5');
    expect(footerLine(null)).toBe('');
    // Integration: the footer rides the final message; cfg.runtimeFooter === false disables it.
    const mk = (cfg: Record<string, unknown>) => {
      const posts: string[] = [];
      const adapter = { cfg, rest: async (_m: string, _p: string, body: { content: string }) => { posts.push(body.content); return { id: `m${posts.length}` }; } };
      return { posts, adapter };
    };
    const on = mk({});
    const lmOn = new LiveMessage(on.adapter, 'chan');
    lmOn.onEvent({ type: 'idle', model: 'openai/gpt-5', usage: { percent: 12 } });
    await lmOn.finalize('Hotovo.');
    expect(on.posts).toEqual(['Hotovo.\n\n-# gpt-5 · 12 %']);
    const off = mk({ runtimeFooter: false });
    const lmOff = new LiveMessage(off.adapter, 'chan');
    lmOff.onEvent({ type: 'idle', model: 'openai/gpt-5', usage: { percent: 12 } });
    await lmOff.finalize('Hotovo.');
    expect(off.posts).toEqual(['Hotovo.']);
  });
});

describe('discord display settings', () => {
  it('defaults to live tool status + one final answer, while preserving legacy booleans', async () => {
    const { resolveDisplaySettings } = (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
      resolveDisplaySettings: (cfg?: Record<string, unknown>, state?: Record<string, unknown>) => Record<string, string>;
    };
    expect(resolveDisplaySettings({})).toEqual({ toolActivity: 'status', answerMode: 'final', toolOutput: 'summary' });
    expect(resolveDisplaySettings({ streaming: true, streamAnswer: true })).toMatchObject({ toolActivity: 'status', answerMode: 'live' });
    expect(resolveDisplaySettings({ streaming: true, streamAnswer: false })).toMatchObject({ toolActivity: 'status', answerMode: 'final' });
    expect(resolveDisplaySettings({ streaming: false })).toMatchObject({ toolActivity: 'off', answerMode: 'final' });
  });

  it('lets each channel override one axis and reset it to the global default independently', async () => {
    const { resolveDisplaySettings, updateDisplayOverrides } = (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
      resolveDisplaySettings: (cfg?: Record<string, unknown>, state?: Record<string, unknown>) => Record<string, string>;
      updateDisplayOverrides: (current: Record<string, string>, values: Record<string, string>) => Record<string, string>;
    };
    const cfg = { toolActivity: 'status', answerMode: 'final', toolOutput: 'summary' };
    const display = updateDisplayOverrides({}, { toolActivity: 'live', toolOutput: 'tail' });
    expect(resolveDisplaySettings(cfg, { display })).toEqual({ toolActivity: 'live', answerMode: 'final', toolOutput: 'tail' });
    const reset = updateDisplayOverrides(display, { toolActivity: 'default' });
    expect(resolveDisplaySettings(cfg, { display: reset })).toEqual({ toolActivity: 'status', answerMode: 'final', toolOutput: 'tail' });
  });

  it('/display persists operator-only channel overrides and reports the resolved policy', async () => {
    const { DiscordAdapter } = await import(join(repoRoot, 'plugins/discord/lib/adapter.mjs')) as { DiscordAdapter: new (...args: unknown[]) => any };
    const channels: Record<string, Record<string, unknown>> = {};
    const state = {
      get: (id: string) => channels[id] ?? {},
      patch: (id: string, fields: Record<string, unknown>) => { channels[id] = { ...(channels[id] ?? {}), ...fields }; },
    };
    const adapter = new DiscordAdapter(
      { language: 'en', toolActivity: 'status', answerMode: 'final', toolOutput: 'summary', rolePolicies: [{ roleId: 'ADMIN', admin: true }] },
      log, state, async () => [],
    );
    const replies: unknown[] = [];
    adapter.rest = async (_method: string, _path: string, body: unknown) => { replies.push(body); return {}; };
    await adapter.onInteraction({
      type: 2, id: 'I', token: 'T', channel_id: 'C', member: { roles: ['ADMIN'] },
      data: { name: 'display', options: [{ name: 'tools', value: 'live' }, { name: 'output', value: 'tail' }] },
    });
    expect(channels.C?.display).toEqual({ toolActivity: 'live', toolOutput: 'tail' });
    expect(JSON.stringify(replies[0])).toContain('tools **live** · answer **final** · output **tail**');
  });
});

describe('discord answer streaming (live reply edits, two-bubble model)', () => {
  interface Ev { type: string; name?: string; detail?: string; icon?: string; delta?: string; model?: string; usage?: { percent: number } }
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
    LiveMessage: new (adapter: unknown, channelId: string, replyToId?: string) => {
      onEvent: (e: Ev) => void; finalize: (reply?: string) => Promise<void>; abandon: () => void;
    };
  };
  interface Call { method: string; id: string; content: string }
  const mk = (cfg?: Record<string, unknown>) => {
    const calls: Call[] = [];
    const posts: string[] = [];
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = {
      cfg: { answerMode: 'live', ...(cfg ?? {}) },
      rest: async (method: string, path: string, body?: { content?: string }) => {
        const content = body?.content ?? '';
        if (method === 'POST') { const id = `m${++nextId}`; posts.push(id); edits.set(id, content); calls.push({ method, id, content }); return { id }; }
        const id = path.split('/').pop()!;
        if (method === 'PATCH') edits.set(id, content);
        calls.push({ method, id, content });
        return { id };
      },
    };
    return { calls, posts, edits, adapter };
  };

  it('streams the answer into ONE message, PATCHing progressively; the trailing delta lands via the throttle timer', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { posts, edits, adapter } = mk();
      const lm = new LiveMessage(adapter, 'chan');
      lm.onEvent({ type: 'text', delta: 'Hello' });   // first delta → immediate POST
      await vi.advanceTimersByTimeAsync(0);
      expect(posts).toEqual(['m1']);
      expect(edits.get('m1')).toBe('Hello');
      lm.onEvent({ type: 'text', delta: ' world' });  // inside the throttle window → deferred
      lm.onEvent({ type: 'text', delta: '!' });        // still inside → coalesced with the above
      expect(edits.get('m1')).toBe('Hello');           // nothing landed yet — throttled
      await vi.advanceTimersByTimeAsync(1200);          // the self-rescheduled trailing flush fires
      expect(posts).toEqual(['m1']);                    // still exactly ONE answer message
      expect(edits.get('m1')).toBe('Hello world!');     // coalesced to the latest content
    } finally { vi.useRealTimers(); }
  });

  it('keeps the tool bubble tool-only, then re-anchors the answer BELOW it so the final answer is LAST', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { calls, adapter } = mk();
      const lm = new LiveMessage(adapter, 'chan');
      lm.onEvent({ type: 'text', delta: 'Let me check. ' }); // narration opens the answer draft FIRST (m1)
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' }); // tool bubble posts below (m2) → answer stranded above
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'text', delta: 'Found it.' }); // streams live into the stranded draft during the turn
      await vi.advanceTimersByTimeAsync(1300);
      await lm.finalize('Found it.');
      const tools = calls.filter((c) => c.id === 'm2');   // the tool bubble
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.every((c) => c.content.includes('read_file'))).toBe(true); // tool bubble only ever holds tool lines
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.id)).toContain('m1'); // stranded draft deleted
      const posts = calls.filter((c) => c.method === 'POST').map((c) => c.id);
      const finalId = posts.at(-1)!; // the answer re-posted LAST, below the trace
      expect(finalId).not.toBe('m1');
      const finalBubble = calls.filter((c) => c.id === finalId);
      expect(finalBubble.every((c) => !c.content.includes('read_file'))).toBe(true); // never gets tool lines
      expect(finalBubble.at(-1)!.content).toBe('Found it.'); // authoritative reply, as the channel's LAST message
    } finally { vi.useRealTimers(); }
  });

  it('overflows a long answer into a code-fence-aware continuation message', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { posts, edits, adapter } = mk();
      const lm = new LiveMessage(adapter, 'chan');
      const big = '```js\n' + 'const x = 1;\n'.repeat(300) + '```'; // > 1990 chars, one open fence
      lm.onEvent({ type: 'text', delta: big });
      await vi.advanceTimersByTimeAsync(1300);
      await lm.finalize(big);
      expect(posts.length).toBeGreaterThanOrEqual(2); // split across ≥2 answer bubbles
      for (const id of posts) {
        const c = edits.get(id)!;
        expect(c.length).toBeLessThanOrEqual(2100);
        expect((c.match(/```/g)?.length ?? 0) % 2).toBe(0); // every bubble has balanced fences
      }
      expect(posts.map((id) => edits.get(id)).join('')).toContain('const x = 1;');
    } finally { vi.useRealTimers(); }
  });

  it('finalize replaces the streamed draft with the returned reply and appends the footer once', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { edits, adapter } = mk({});
      const lm = new LiveMessage(adapter, 'chan');
      lm.onEvent({ type: 'text', delta: 'streamed draft that will be replaced' });
      lm.onEvent({ type: 'idle', model: 'openai/gpt-5', usage: { percent: 30 } });
      await vi.advanceTimersByTimeAsync(1300);
      await lm.finalize('Final clean answer.');
      expect(edits.get('m1')).toBe('Final clean answer.\n\n-# gpt-5 · 30 %'); // reply wins over the draft, footer once
    } finally { vi.useRealTimers(); }
  });

  it('abandon() freezes both bubbles — no edit lands after the error reply', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { calls, adapter } = mk();
      const lm = new LiveMessage(adapter, 'chan');
      lm.onEvent({ type: 'text', delta: 'partial answer' });
      lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' });
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'text', delta: ' more text' }); // queued behind the throttle
      lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' }); // queued behind the throttle
      lm.abandon();
      const before = calls.length;
      await vi.advanceTimersByTimeAsync(5000); // any armed trailing flush would fire in here
      expect(calls.length).toBe(before); // both bubbles frozen — nothing landed
    } finally { vi.useRealTimers(); }
  });

  it('the first answer bubble is a real reply to the triggering message; continuations are plain', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const refs: (unknown)[] = [];
      let nextId = 0;
      const adapter = {
        cfg: { answerMode: 'live' },
        rest: async (method: string, _path: string, body?: { message_reference?: unknown }) => {
          if (method === 'POST') { refs.push(body?.message_reference); return { id: `m${++nextId}` }; }
          return { id: 'x' };
        },
      };
      const lm = new LiveMessage(adapter, 'chan', 'TRIGGER');
      lm.onEvent({ type: 'text', delta: 'answer text' });
      await vi.advanceTimersByTimeAsync(0);
      expect(refs[0]).toEqual({ message_id: 'TRIGGER', fail_if_not_exists: false }); // reply ref rides the first POST
    } finally { vi.useRealTimers(); }
  });

  it('retries a failed final PATCH instead of freezing the answer at the mid-stream draft (#2)', async () => {
    const { LiveMessage } = await load();
    const edits = new Map<string, string>();
    let nextId = 0;
    let failNextPatch = false;
    let patchAttempts = 0;
    const adapter = {
      cfg: { answerMode: 'live' },
      rest: async (method: string, path: string, body?: { content?: string }) => {
        if (method === 'POST') { const id = `m${++nextId}`; edits.set(id, body?.content ?? ''); return { id }; }
        if (method === 'PATCH') {
          patchAttempts++;
          if (failNextPatch) { failNextPatch = false; throw new Error('429 rate limited'); } // one transient blip
          edits.set(path.split('/').pop()!, body?.content ?? '');
        }
        return { id: 'x' };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'text', delta: 'streamed draft' });
    await new Promise((r) => setTimeout(r, 20)); // the draft POSTs as m1
    failNextPatch = true;                         // the finalize settle's FIRST PATCH hits a 429
    await lm.finalize('Final clean answer.');
    expect(patchAttempts).toBe(2);                         // first PATCH threw and was swallowed → retried once
    expect(edits.get('m1')).toBe('Final clean answer.');   // authoritative reply landed, NOT frozen at the draft
  });

  it('an image-only reply deletes the streamed raw-markdown draft instead of freezing it (#4)', async () => {
    const { LiveMessage } = await load();
    const calls: { method: string; id: string; content: string }[] = [];
    let uploads = 0;
    let nextId = 0;
    const adapter = {
      cfg: { answerMode: 'live' },
      resolveImageFiles: (names: string[]) => names.map((n) => ({ name: n, blob: new Uint8Array([1]) })),
      uploadImages: async () => { uploads++; },
      rest: async (method: string, path: string, body?: { content?: string }) => {
        if (method === 'POST') { const id = `m${++nextId}`; calls.push({ method, id, content: body?.content ?? '' }); return { id }; }
        const id = path.split('/').pop()!;
        calls.push({ method, id, content: body?.content ?? '' });
        return { id };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    // The model streams text that is ONLY a generated-image link → a StreamingAnswer bubble is created
    // holding raw markdown, which is dead text on Discord.
    lm.onEvent({ type: 'text', delta: '![kočka](/api/brain/images/abc123.png)' });
    await new Promise((r) => setTimeout(r, 20)); // the draft bubble (m1) is POSTed
    await lm.finalize('![kočka](/api/brain/images/abc123.png)');
    expect(uploads).toBe(1); // the image rode its own upload
    // The raw-markdown draft is DELETED, not left frozen above the standalone image.
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.id)).toContain('m1');
  });

  it('deletes a leftover continuation bubble whose create POST is still in flight at finalize (#7)', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const calls: { method: string; id: string }[] = [];
      let nextId = 0;
      const adapter = {
        cfg: { answerMode: 'live' },
        rest: (method: string, path: string) => {
          if (method === 'POST') {
            const id = `m${++nextId}`;
            calls.push({ method, id });
            // bubble0 (m1) posts instantly; the continuation's create (m2) is slow → still in flight at finalize.
            return new Promise<{ id: string }>((res) => setTimeout(() => res({ id }), id === 'm2' ? 50 : 0));
          }
          const id = path.split('/').pop()!;
          calls.push({ method, id });
          return Promise.resolve({ id });
        },
      };
      const lm = new LiveMessage(adapter, 'chan');
      const big = 'A'.repeat(1990) + '\n' + 'B'.repeat(500); // splits into 2 answer bubbles
      lm.onEvent({ type: 'text', delta: big });
      await vi.advanceTimersByTimeAsync(0);  // bubble0 (m1) resolves; bubble1's POST (m2) fires, in flight (+50ms)
      const done = lm.finalize('short');     // final reply is 1 piece → bubble1 (m2) is a leftover to delete
      await vi.advanceTimersByTimeAsync(0);  // finalize settles bubble0, reaches the leftover loop, awaits bubble1.sending
      await vi.advanceTimersByTimeAsync(60); // bubble1's in-flight POST resolves → deleteBubble now knows m2 and DELETEs it
      await done;
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.id)).toContain('m2'); // no orphan mid-stream chunk left
    } finally { vi.useRealTimers(); }
  });

  it('serializes continuation-bubble creates so split pieces post in channel order (#9)', async () => {
    const { LiveMessage } = await load();
    const initiated: string[] = []; // POST ids in the order they are actually SENT
    const queue: Array<() => void> = [];
    let nextId = 0;
    const adapter = {
      cfg: { answerMode: 'live' },
      rest: (method: string, path: string) => {
        if (method === 'POST') {
          const id = `m${++nextId}`;
          initiated.push(id);
          return new Promise<{ id: string }>((res) => queue.push(() => res({ id }))); // gated: resolve on demand
        }
        return Promise.resolve({ id: path.split('/').pop()! });
      },
    };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const lm = new LiveMessage(adapter, 'chan');
    // One big delta that splits into THREE pieces → bubble0,1,2 are created in a SINGLE update() call.
    const big = 'A'.repeat(1990) + '\n' + 'B'.repeat(1990) + '\n' + 'C'.repeat(500);
    lm.onEvent({ type: 'text', delta: big });
    await tick();
    expect(initiated).toEqual(['m1']);              // serialized: only bubble0's create is in flight
    queue.shift()!(); await tick();
    expect(initiated).toEqual(['m1', 'm2']);         // bubble1's create fires only AFTER bubble0's resolves
    queue.shift()!(); await tick();
    expect(initiated).toEqual(['m1', 'm2', 'm3']);   // bubble2's create fires only AFTER bubble1's — order preserved
    queue.shift()!(); await tick();                  // drain the last so no dangling promise
  });

  it('text→tool→text→tool→text yields exactly ONE final answer, BELOW the trace, no duplicates (#3)', async () => {
    vi.useFakeTimers();
    try {
      const { LiveMessage } = await load();
      const { calls, adapter } = mk();
      const lm = new LiveMessage(adapter, 'chan');
      lm.onEvent({ type: 'text', delta: 'First. ' });             // answer draft m1
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' }); // tool bubble m2 → answer stranded above
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'text', delta: 'Second. ' });
      await vi.advanceTimersByTimeAsync(1300);
      lm.onEvent({ type: 'tool', name: 'run_command', icon: '💻' }); // same single trace bubble m2
      await vi.advanceTimersByTimeAsync(0);
      lm.onEvent({ type: 'text', delta: 'Third.' });
      await vi.advanceTimersByTimeAsync(1300);
      await lm.finalize('The complete answer.');
      expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.id)).toContain('m1'); // stranded draft removed
      const answered = new Set(calls.filter((c) => c.content === 'The complete answer.').map((c) => c.id));
      expect(answered.size).toBe(1);                 // exactly one bubble carries the final answer — no duplicates
      expect(answered.has('m1')).toBe(false);        // and it is NOT the stranded draft
      const finalId = [...answered][0];
      const posts = calls.filter((c) => c.method === 'POST').map((c) => c.id);
      expect(posts.indexOf(finalId)).toBeGreaterThan(posts.indexOf('m2')); // answer posted AFTER the tool trace
    } finally { vi.useRealTimers(); }
  });
});

describe('discord reasoning stream (off by default, opt-in via cfg.showReasoning)', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
    LiveMessage: new (adapter: unknown, channelId: string) => { onEvent: (e: unknown) => void; finalize: (reply?: string) => Promise<void> };
  };
  const mk = (cfg?: Record<string, unknown>) => {
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = {
      cfg,
      rest: async (method: string, path: string, body: { content: string }) => {
        const id = method === 'POST' ? `m${++nextId}` : path.split('/').pop()!;
        edits.set(id, body.content);
        return { id };
      },
    };
    return { edits, adapter };
  };

  it('drops reasoning entirely with no config (never opens a progress bubble)', async () => {
    const { LiveMessage } = await load();
    const { edits, adapter } = mk();
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'reasoning', delta: 'thinking hard about it' });
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('Answer.');
    expect([...edits.values()]).toEqual(['Answer.']); // only the answer, no reasoning bubble
  });

  it('streams reasoning into the progress bubble when cfg.showReasoning is on', async () => {
    const { LiveMessage } = await load();
    const { edits, adapter } = mk({ showReasoning: true });
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'reasoning', delta: 'let me reason ' });
    lm.onEvent({ type: 'reasoning', delta: 'about this' });
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('Answer.');
    expect(edits.get('m1')).toContain('💭'); // reasoning surfaced in the progress bubble
    expect(edits.get('m1')).toContain('let me reason about this');
  });
});

describe('discord stripForSpeech (markdown → plain prose for TTS)', () => {
  it('strips code, links, images and md punctuation into speakable text', async () => {
    const { stripForSpeech } = await import(join(repoRoot, 'plugins/discord/index.mjs')) as { stripForSpeech: (s: string) => string };
    expect(stripForSpeech('# Nadpis\n**tučně** a `kód`')).toBe('Nadpis tučně a kód');
    expect(stripForSpeech('viz [odkaz](https://x.io) tady')).toBe('viz odkaz tady');
    expect(stripForSpeech('```js\nconst x=1\n```\nhotovo')).toBe('hotovo');
    expect(stripForSpeech('čistý http://a.b/c konec')).toBe('čistý konec');
    expect(stripForSpeech('')).toBe('');
  });
});

describe('discord memberIsAdmin (operator-only picker gate)', () => {
  it('is true only for a member holding a role mapped admin:true', async () => {
    const { memberIsAdmin } = await import(join(repoRoot, 'plugins/discord/index.mjs')) as { memberIsAdmin: (r: unknown, p: unknown) => boolean };
    const policies = [
      { roleId: 'r-admin', admin: true, projectIds: [] },
      { roleId: 'r-user', projectIds: [1] },
    ];
    expect(memberIsAdmin(['r-admin'], policies)).toBe(true);
    expect(memberIsAdmin(['r-user'], policies)).toBe(false);       // mapped, but not admin
    expect(memberIsAdmin(['r-user', 'r-admin'], policies)).toBe(true);
    expect(memberIsAdmin(['r-nobody'], policies)).toBe(false);     // unmapped role
    expect(memberIsAdmin([], policies)).toBe(false);
    expect(memberIsAdmin(['r-admin'], undefined)).toBe(false);     // no policies configured
  });
});

describe('discord extractImageRefs (generated-image markdown → uploads)', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as unknown as {
    extractImageRefs: (t: string) => { cleaned: string; files: string[] };
  };

  it('extracts a relative daemon link and removes it from the text', async () => {
    const { extractImageRefs } = await load();
    const r = extractImageRefs('Tady je obrázek: ![kočka](/api/brain/images/abc123.png) hotovo');
    expect(r.files).toEqual(['abc123.png']);
    expect(r.cleaned).toBe('Tady je obrázek:  hotovo');
  });

  it('extracts multiple links, including an absolute-URL variant', async () => {
    const { extractImageRefs } = await load();
    const r = extractImageRefs('![a](/api/brain/images/aaa1.png)\n![b](https://example.com/api/brain/images/bbb2.png)');
    expect(r.files).toEqual(['aaa1.png', 'bbb2.png']);
    expect(r.cleaned.trim()).toBe('');
  });

  it('leaves text-only messages untouched', async () => {
    const { extractImageRefs } = await load();
    const r = extractImageRefs('žádný obrázek tady není');
    expect(r.files).toEqual([]);
    expect(r.cleaned).toBe('žádný obrázek tady není');
  });

  it('rejects names outside the daemon route pattern (path traversal stays inert text)', async () => {
    const { extractImageRefs } = await load();
    const r = extractImageRefs('![x](/api/brain/images/../evil.png) a ![y](/api/brain/images/UPPER.png)');
    expect(r.files).toEqual([]);
    expect(r.cleaned).toContain('../evil.png'); // untouched — never treated as a file
  });
});

describe('discord context helpers', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as unknown as {
    displayNameOf: (m: unknown) => string;
    resolveMentions: (text: string, mentions: unknown[], rolePolicies: unknown[], channelNames: Map<string, string>) => string;
    buildReplyContext: (ref: unknown) => string;
  };

  it('displayNameOf prefers server nick > global name > username > unknown', async () => {
    const { displayNameOf } = await load();
    expect(displayNameOf({ member: { nick: 'Anička' }, author: { global_name: 'Anna G', username: 'anna' } })).toBe('Anička');
    expect(displayNameOf({ member: {}, author: { global_name: 'Anna G', username: 'anna' } })).toBe('Anna G');
    expect(displayNameOf({ author: { username: 'anna' } })).toBe('anna');
    expect(displayNameOf({})).toBe('unknown');
  });

  it('resolveMentions replaces <@id> and <@!id> with display names, roles from policies, channels from the cache', async () => {
    const { resolveMentions } = await load();
    const mentions = [
      { id: '1', username: 'bob', global_name: 'Bobby' },
      { id: '2', username: 'eva', member: { nick: 'Evka' } },
    ];
    const policies = [{ roleId: '9', name: 'Dev tým' }];
    const channels = new Map([['77', 'general']]);
    const out = resolveMentions('hey <@1> and <@!2>, ping <@&9> + <@&8> in <#77> or <#88>', mentions, policies, channels);
    expect(out).toBe('hey @Bobby and @Evka, ping @Dev tým + @role in #general or <#88>');
  });

  it('buildReplyContext caps the excerpt at 300 chars and falls back through author names', async () => {
    const { buildReplyContext } = await load();
    expect(buildReplyContext(null)).toBe(''); // deleted/absent original
    const short = buildReplyContext({ author: { username: 'bob', global_name: 'Bobby' }, content: 'hello' });
    expect(short).toBe('[Replying to Bobby: "hello"]');
    const long = buildReplyContext({ author: { username: 'bob' }, content: 'x'.repeat(400) });
    expect(long).toBe(`[Replying to bob: "${'x'.repeat(300)}…"]`);
  });
});

describe('discord onMessage context pipeline', () => {
  it('strips the bot mention, resolves other mentions, prefixes the speaker, quotes the reply, notes non-image attachments, and carries channel metadata', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['discord'], logger: log,
      config: { discord: { botToken: 'tok', rolePolicies: [{ roleId: 'R1', name: 'Dev', projectIds: [1] }], streaming: false, reactions: false } },
    });
    const adapter = reg.platforms[0] as unknown as {
      botId: string | null;
      rest: (method: string, path: string, body?: unknown) => Promise<unknown>;
      listen: (h: (src: Record<string, unknown>, text: string) => Promise<string | undefined>) => void;
      onMessage: (m: unknown) => Promise<void>;
    };
    adapter.botId = 'BOT';
    adapter.rest = async (_method: string, path: string) => {
      if (path === '/channels/100') return { id: '100', name: 'general', topic: 'Team chat', type: 0 };
      return {};
    };
    let seen: { src: Record<string, unknown>; text: string } | undefined;
    adapter.listen(async (src, text) => { seen = { src, text }; return 'ok'; });

    await adapter.onMessage({
      type: 19, // REPLY — a real user turn
      guild_id: 'G', channel_id: '100', id: 'MSG',
      author: { id: 'U1', username: 'anna', global_name: 'Anna G' },
      member: { nick: 'Anička', roles: ['R1'] },
      mentions: [{ id: 'BOT', username: 'elowen' }, { id: 'U2', username: 'bob', global_name: 'Bobby' }],
      content: '<@BOT> ahoj <@!U2> mrkni na <#100>',
      referenced_message: { author: { id: 'U2', username: 'bob', global_name: 'Bobby' }, content: 'původní zpráva' },
      attachments: [{ filename: 'spec.pdf', content_type: 'application/pdf', size: 1000, url: 'http://cdn/spec.pdf' }],
    });

    expect(seen).toBeDefined();
    expect(seen!.text).toBe('[Replying to Bobby: "původní zpráva"]\n[Anička] ahoj @Bobby mrkni na #general\n[Attachment: spec.pdf (application/pdf)]');
    expect(seen!.src.userName).toBe('Anička');
    expect(seen!.src.channelName).toBe('general');
    expect(seen!.src.channelTopic).toBe('Team chat');
    expect(seen!.src.images).toBeUndefined();
    expect(seen!.src.channelId).toBe('100#0');
  });

  it('ignores Discord system messages (channel renames, pins, joins) — only DEFAULT/REPLY are turns', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['discord'], logger: log,
      config: { discord: { botToken: 'tok', rolePolicies: [{ roleId: 'R1', name: 'Dev', projectIds: [1] }], streaming: false, reactions: false } },
    });
    const adapter = reg.platforms[0] as unknown as {
      botId: string | null;
      listen: (h: (src: Record<string, unknown>, text: string) => Promise<string | undefined>) => void;
      onMessage: (m: unknown) => Promise<void>;
    };
    adapter.botId = 'BOT';
    let fired = false;
    adapter.listen(async () => { fired = true; return 'ok'; });
    // type 4 = CHANNEL_NAME_CHANGE ("X changed the channel name"): authored by a real member, not a bot.
    await adapter.onMessage({ type: 4, guild_id: 'G', channel_id: '100', id: 'SYS', author: { id: 'U1', username: 'anna' }, member: { roles: ['R1'] }, content: '' });
    expect(fired).toBe(false);
  });
});

describe('discord buildAskComponents (ask_user_question rendering)', () => {
  interface Component { type: number; custom_id?: string; label?: string; style?: number; options?: { label: string; value: string }[]; min_values?: number; max_values?: number }
  interface Row { type: number; components: Component[] }
  const load = async () => (await import(join(repoRoot, 'plugins/discord/index.mjs'))) as {
    buildAskComponents: (id: string, questions: unknown[], opts?: { cs?: boolean; selected?: Record<number, string[]> }) => Row[];
  };
  const q = (over: Record<string, unknown> = {}) => ({
    question: 'Which colour?', header: 'Colour', multiSelect: false,
    options: [{ label: 'Blue' }, { label: 'Green' }], ...over,
  });

  it('renders a small single-select question as one button row (≤5 buttons) with no Submit — a click answers', async () => {
    const { buildAskComponents } = await load();
    const rows = buildAskComponents('ID', [q()]);
    expect(rows).toHaveLength(2); // options row + footer (Other only)
    expect(rows[0].components.map((c) => c.type)).toEqual([2, 2]); // buttons
    expect(rows[0].components.map((c) => c.custom_id)).toEqual(['ask:ID:0:0', 'ask:ID:0:1']);
    const footer = rows[1].components.map((c) => c.custom_id);
    expect(footer).not.toContain('ask:ID:submit');
    expect(footer).toContain('ask:ID:other');
  });

  it('uses a select menu when multiple=true or when a question has more than 5 options', async () => {
    const { buildAskComponents } = await load();
    const multi = buildAskComponents('ID', [q({ multiSelect: true })]);
    expect(multi[0].components[0].type).toBe(3); // string select
    expect(multi[0].components[0].max_values).toBe(2);
    const many = buildAskComponents('ID', [q({ options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) })]);
    expect(many[0].components[0].type).toBe(3);
    expect(many[0].components[0].options).toHaveLength(7);
    // Both need the explicit Submit button.
    expect(multi.at(-1)!.components.map((c) => c.custom_id)).toContain('ask:ID:submit');
  });

  it('omits the free-text "Other" button when custom is false, keeps it when absent (older events)', async () => {
    const { buildAskComponents } = await load();
    const strict = buildAskComponents('ID', [q({ custom: false })]);
    const ids = strict.flatMap((r) => r.components.map((c) => c.custom_id));
    expect(ids).not.toContain('ask:ID:other');
    const legacy = buildAskComponents('ID', [q()]);
    expect(legacy.flatMap((r) => r.components.map((c) => c.custom_id))).toContain('ask:ID:other');
  });

  it('marks the picked option button green and keeps Submit on multi-question asks', async () => {
    const { buildAskComponents } = await load();
    const rows = buildAskComponents('ID', [q(), q({ question: 'Pick tools', header: 'Tools' })], { selected: { 0: ['Green'] } });
    expect(rows[0].components.map((c) => c.style)).toEqual([2, 3]); // Green picked
    expect(rows.at(-1)!.components.map((c) => c.custom_id)).toContain('ask:ID:submit');
  });

  it('caps at 4 question rows + 1 footer row (Discord allows 5 action rows)', async () => {
    const { buildAskComponents } = await load();
    const rows = buildAskComponents('ID', Array.from({ length: 6 }, (_, i) => q({ question: `Q${i}` })));
    expect(rows.length).toBeLessThanOrEqual(5);
  });
});

describe('discord configurable media/timeout limits', () => {
  const mkAdapter = async (extraCfg: Record<string, unknown> = {}) => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['discord'], logger: log,
      config: { discord: { botToken: 'tok', rolePolicies: [{ roleId: 'R1', name: 'Dev', projectIds: [1] }], streaming: false, reactions: false, ...extraCfg } },
    });
    const adapter = reg.platforms[0] as unknown as {
      botId: string | null;
      pendingAsks: Map<string, { channelId: string; askerId: string; createdAt: number }>;
      rest: (method: string, path: string, body?: unknown) => Promise<unknown>;
      listen: (h: (src: Record<string, unknown>, text: string) => Promise<string | undefined>) => void;
      onMessage: (m: unknown) => Promise<void>;
    };
    adapter.botId = 'BOT';
    adapter.rest = async (_method: string, path: string) => {
      if (path === '/channels/100') return { id: '100', name: 'general', topic: '', type: 0 };
      return {};
    };
    return adapter;
  };

  it('maxImages unset reproduces the default cap (4): a 5th image attachment falls over it', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const adapter = await mkAdapter();
    let seen: { src: Record<string, unknown> } | undefined;
    adapter.listen(async (src) => { seen = { src }; return undefined; });
    await adapter.onMessage({
      type: 0, guild_id: 'G', channel_id: '100', id: 'MSG',
      author: { id: 'U1', username: 'anna' }, member: { roles: ['R1'] },
      content: 'look',
      attachments: [0, 1, 2, 3, 4].map((i) => ({ filename: `i${i}.png`, content_type: 'image/png', size: 100, url: `http://cdn/${i}.png` })),
    });
    expect((seen!.src.images as unknown[])?.length).toBe(4);
  });

  it('a configured maxImages overrides the default, capping how many attachments become vision images', async () => {
    global.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;
    const adapter = await mkAdapter({ maxImages: 2 });
    let seen: { src: Record<string, unknown> } | undefined;
    adapter.listen(async (src) => { seen = { src }; return undefined; });
    await adapter.onMessage({
      type: 0, guild_id: 'G', channel_id: '100', id: 'MSG',
      author: { id: 'U1', username: 'anna' }, member: { roles: ['R1'] },
      content: 'look',
      attachments: [0, 1, 2].map((i) => ({ filename: `i${i}.png`, content_type: 'image/png', size: 100, url: `http://cdn/${i}.png` })),
    });
    expect((seen!.src.images as unknown[])?.length).toBe(2); // 3rd attachment fell over the configured cap
  });

  it('askTimeoutMs unset reproduces the default (~6 min): a 60s-old pending ask is NOT pruned', async () => {
    const adapter = await mkAdapter();
    adapter.listen(async () => undefined);
    adapter.pendingAsks.set('ask1', { channelId: 'OTHER', askerId: 'U9', createdAt: Date.now() - 60_000 });
    // An unrelated message (unmapped role → onMessage returns right after the prune loop) still runs the prune.
    await adapter.onMessage({ type: 0, guild_id: 'G', channel_id: '999', id: 'M2', author: { id: 'U2', username: 'x' }, member: { roles: [] }, content: 'hi' });
    expect(adapter.pendingAsks.has('ask1')).toBe(true);
  });

  it('a configured askTimeoutMs overrides the default, pruning a pending ask once it is older than the cap', async () => {
    const adapter = await mkAdapter({ askTimeoutMs: 30000 }); // the allowed minimum (30s)
    adapter.listen(async () => undefined);
    adapter.pendingAsks.set('ask1', { channelId: 'OTHER', askerId: 'U9', createdAt: Date.now() - 60_000 }); // 60s old > 30s cap
    await adapter.onMessage({ type: 0, guild_id: 'G', channel_id: '999', id: 'M2', author: { id: 'U2', username: 'x' }, member: { roles: [] }, content: 'hi' });
    expect(adapter.pendingAsks.has('ask1')).toBe(false);
  });
});

describe('files plugin tool icons are emoji glyphs (Discord toolLine renders manifest.icon verbatim)', () => {
  it('every icon value in the files manifest is a real emoji, with the expected mapping', () => {
    // The Discord renderer (stream.mjs toolLine) prints `${c.icon ?? '🔧'}` verbatim, so a word value like
    // "file"/"edit"/"search" (the original bug) renders as literal text, reading as "no icon". Guard against
    // a regression to word values across every tool the files plugin ships.
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'plugins/files/elowen-plugin.json'), 'utf-8')) as { icons: Record<string, string> };
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [tool, icon] of Object.entries(manifest.icons)) {
      expect(emoji.test(icon), `${tool} icon "${icon}" must be an emoji glyph`).toBe(true);
    }
    expect(manifest.icons).toMatchObject({
      read_file: '📄', list_dir: '📂', write_file: '✏️', edit_file: '✏️', search_files: '🔎', file_info: '📄', git_status: '🌿',
    });
  });
});
