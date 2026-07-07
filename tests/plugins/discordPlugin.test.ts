import { describe, it, expect } from 'vitest';
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

  it('tools stack tightly in one bubble with arg previews; the answer is the LAST clean message', async () => {
    const { LiveMessage } = await load();
    const posts: string[] = []; // message ids in creation order
    const edits = new Map<string, string>();
    let nextId = 0;
    const adapter = {
      rest: async (method: string, path: string, body: { content: string }) => {
        if (method === 'POST') { const id = `m${++nextId}`; posts.push(id); edits.set(id, body.content); return { id }; }
        const id = path.split('/').pop()!;
        edits.set(id, body.content);
        return { id };
      },
    };
    const lm = new LiveMessage(adapter, 'chan');
    lm.onEvent({ type: 'text', delta: 'Mrknu na to… ' }); // narration BEFORE tools must not create a message
    lm.onEvent({ type: 'tool', name: 'run_command', detail: 'apt list --upgradable', icon: '💻' });
    lm.onEvent({ type: 'tool', name: 'read_file', icon: '📄' });
    await new Promise((r) => setTimeout(r, 20));
    await lm.finalize('Hotovo, vše běží.');
    expect(posts.length).toBe(2);
    const [progressId, answerId] = posts;
    expect(edits.get(progressId)).toBe('💻 `run_command`: "apt list --upgradable"\n📄 `read_file`…'); // single \n = tight
    expect(edits.get(progressId)).not.toContain('\n\n');
    expect(edits.get(answerId)).toBe('Hotovo, vše běží.'); // last message = the clean summary
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
    expect(edits.get('m1')).toBe('✂️ `sarah_hair`: "list_bookings" ×3\n📄 `read_file`…\n✂️ `sarah_hair`…');
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
      mentions: [{ id: 'BOT', username: 'orca' }, { id: 'U2', username: 'bob', global_name: 'Bobby' }],
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
