import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadPlugins } from '../../src/plugins/loader.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CREDS = { appId: 'app-guid', appPassword: 's3cret', tenantId: 'tenant-guid' };

type AdapterModule = {
  MsTeamsAdapter: new (
    cfg: Record<string, unknown>, logger: typeof log, state: unknown, listModels: () => Promise<unknown[]>,
    imageDirs?: string[], resolveProvider?: () => null, answerQuestion?: (id: string, answers: unknown[]) => boolean,
    chatCommands?: () => { name: string; description: string; kind: string }[],
  ) => {
    handleWebhook: (req: { method: string; headers: Record<string, string>; json: () => Promise<unknown> }) => Promise<{ status?: number }>;
    onActivity: (m: unknown) => Promise<void>;
    onCardAction: (m: unknown) => Promise<void>;
    postAsk: (convId: string, replyToId: string, askerId: string, id: string, questions: unknown[]) => Promise<void>;
    listen: (h: (src: Record<string, unknown>, text: string, onEvent?: (e: Record<string, unknown>) => void) => Promise<string | undefined>) => void;
    stripMention: (t: string) => string;
    isForMe: (m: unknown) => boolean;
    accessFor: (ids: string[], convId: string) => { access?: Record<string, unknown> };
    verifyToken: (h: string | undefined, a: unknown) => Promise<boolean>;
    notify: (text: string, channelId?: string) => Promise<void>;
    appPackage: () => Buffer;
    readRoster: (conversationId: string) => Promise<Record<string, unknown>[]>;
    lookupPeople: (query: string) => Record<string, unknown>[];
    messagePerson: (target: Record<string, unknown>, text: string) => Promise<{ person: Record<string, unknown>; conversationId: string }>;
    unknownPersonHelp: (label: string) => string;
    connector: Record<string, unknown>;
    pendingAsks: Map<string, Record<string, unknown>>;
    pendingPickers: Map<string, Record<string, unknown>>;
  };
};

class MemoryState {
  data: Record<string, Record<string, unknown>> = {};
  all() { return this.data; }
  get(id: string) { return this.data[id] ?? {}; }
  patch(id: string, fields: Record<string, unknown>) { this.data[id] = { ...this.data[id], ...fields }; }
}

async function makeAdapter(cfg: Record<string, unknown> = {}, opts: {
  answers?: { id: string; answers: unknown[] }[];
  models?: unknown[];
} = {}) {
  const { MsTeamsAdapter } = await import(join(repoRoot, 'plugins/msteams/lib/adapter.mjs')) as AdapterModule;
  const state = new MemoryState();
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger = { ...log, error: (m: string) => { errors.push(m); }, warn: (m: string) => { warnings.push(m); } };
  const adapter = new MsTeamsAdapter(
    { ...CREDS, ...cfg }, logger, state, async () => opts.models ?? [], [], () => null,
    (id, answers) => { (opts.answers ??= []).push({ id, answers }); return true; },
    () => [],
  );
  // Quiet transport for unit tests: no network, capture the outbound calls.
  const calls: { kind: string; args: unknown[] }[] = [];
  let sendSeq = 0;
  Object.assign(adapter.connector, {
    typing: async (...args: unknown[]) => { calls.push({ kind: 'typing', args }); },
    reply: async (...args: unknown[]) => { calls.push({ kind: 'reply', args }); return `act-r${++sendSeq}`; },
    send: async (...args: unknown[]) => { calls.push({ kind: 'send', args }); return `act-s${++sendSeq}`; },
    update: async (...args: unknown[]) => { calls.push({ kind: 'update', args }); },
    remove: async (...args: unknown[]) => { calls.push({ kind: 'remove', args }); },
    member: async () => ({ userPrincipalName: 'alex@contoso.com' }),
    download: async () => Buffer.from('img'),
    token: async () => 'tok',
  });
  return { adapter, state, calls, errors, warnings };
}

/** The Teams* tools against a fake plugin ctx, so the gates can be driven from a test. */
async function makeTools(adapter: unknown, gate: { admin?: boolean; owner?: boolean } = {}) {
  const { registerTools } = await import(join(repoRoot, 'plugins/msteams/lib/tools.mjs')) as {
    registerTools: (ctx: unknown, adapter: unknown) => void;
  };
  type Tool = { name: string; execute: (id: string, p: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
  const tools = new Map<string, Tool>();
  registerTools({
    isAdminSession: () => gate.admin === true,
    currentIdentity: () => ({ owner: gate.owner === true }),
    registerTool: (t: Tool) => { tools.set(t.name, t); },
  }, adapter);
  const run = async (name: string, params: Record<string, unknown> = {}) => {
    const out = await tools.get(name)!.execute('call-1', params);
    return out.content.map((c) => c.text).join('\n');
  };
  return { tools, run };
}

/** Global fetch stub — the ONLY seam Microsoft Graph rides (the connector is stubbed per adapter). */
function stubFetch(route: (url: string, method: string) => { status: number; body: unknown } | undefined) {
  const seen: { url: string; method: string; body?: string }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ url, method, body: init?.body });
    const hit = route(url, method) ?? { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
    return {
      ok: hit.status >= 200 && hit.status < 300,
      status: hit.status,
      headers: { get: () => null },
      text: async () => (typeof hit.body === 'string' ? hit.body : JSON.stringify(hit.body)),
      json: async () => hit.body,
    };
  }) as unknown as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const TOKEN_URL = 'https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token';

const activity = (over: Record<string, unknown> = {}) => ({
  type: 'message',
  id: 'in-1',
  serviceUrl: 'https://smba.test/emea',
  from: { id: '29:enc', aadObjectId: 'aad-1', name: 'Alex Rivera' },
  recipient: { id: '28:bot', name: 'Elowen' },
  conversation: { id: 'a:conv1', conversationType: 'personal', tenantId: 'tenant-guid' },
  text: 'hello there',
  ...over,
});

describe('msteams plugin registration', () => {
  it('registers no platform or route without full credentials', async () => {
    const reg = await loadPlugins({ dirs: [join(repoRoot, 'plugins')], enabled: ['msteams'], logger: log });
    expect(reg.platforms).toHaveLength(0);
    expect(reg.httpRoutes.size).toBe(0);
  });

  it('registers the platform adapter and the /hooks mount when configured', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['msteams'], logger: log,
      config: { msteams: { ...CREDS, rolePolicies: [] } },
    });
    expect(reg.platforms.map((p) => p.name)).toEqual(['msteams']);
    expect([...reg.httpRoutes.keys()]).toEqual(['msteams/messages']);
  });
});

describe('msteams identity + role mapping', () => {
  it('matches Entra GUIDs exactly and UPN/email case-insensitively', async () => {
    const { matchesId, senderIds } = await import(join(repoRoot, 'plugins/msteams/index.mjs')) as {
      matchesId: (a: string, b: string) => boolean; senderIds: (f: unknown, c: string, u?: string) => string[];
    };
    expect(matchesId('aad-1', 'aad-1')).toBe(true);
    expect(matchesId('AAD-1', 'aad-1')).toBe(false);
    expect(matchesId('Alex@Contoso.com', 'alex@contoso.com')).toBe(true);
    expect(senderIds({ id: '29:enc', aadObjectId: 'aad-1' }, 'a:conv1', 'alex@contoso.com'))
      .toEqual(['aad-1', '29:enc', 'alex@contoso.com', 'a:conv1']);
  });

  it('offers the bare channel id too, so a policy from a Teams deep link matches a channel post', async () => {
    const { senderIds } = await import(join(repoRoot, 'plugins/msteams/index.mjs')) as {
      senderIds: (f: unknown, c: string, u?: string) => string[];
    };
    // A team-channel activity appends the thread: only the bare id is copyable from a deep link.
    expect(senderIds({ aadObjectId: 'aad-1' }, '19:chan@thread.tacv2;messageid=1700000000000'))
      .toEqual(['aad-1', '19:chan@thread.tacv2;messageid=1700000000000', '19:chan@thread.tacv2']);
    // A conversation id with no thread suffix must not be duplicated.
    expect(senderIds({ aadObjectId: 'aad-1' }, '19:chan@thread.tacv2'))
      .toEqual(['aad-1', '19:chan@thread.tacv2']);
  });

  it('grants access by first matching policy and drops unmapped senders', async () => {
    const { adapter } = await makeAdapter({ rolePolicies: [
      { roleId: 'a:conv1', name: 'Dev', projectIds: [2], prompt: 'Be terse.' },
      { roleId: 'aad-1', admin: true, projectIds: [1] },
    ] });
    const byConversation = adapter.accessFor(['aad-9', '29:x', 'a:conv1'], 'a:conv1');
    expect(byConversation.access).toMatchObject({ admin: false, projectIds: [2] });
    expect(String(byConversation.access?.prompt)).toContain('Be terse.');
    expect(adapter.accessFor(['aad-unknown'], 'a:conv2').access).toBeUndefined();
  });

  it('routes a mapped personal message to the brain and replies via the connector', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [1] }] });
    const seen: { src: Record<string, unknown>; text: string }[] = [];
    adapter.listen(async (src, text) => { seen.push({ src, text }); return 'brain says hi'; });
    await adapter.onActivity(activity());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.src).toMatchObject({ platform: 'msteams', userId: 'aad-1', userName: 'Alex Rivera', channelId: 'a:conv1#0' });
    expect(seen[0]!.text).toBe('[Alex Rivera] hello there');
    const reply = calls.find((c) => c.kind === 'reply');
    expect(reply?.args[3]).toMatchObject({ type: 'message', textFormat: 'markdown', text: 'brain says hi' });
  });

  it('drops an unmapped sender without any outbound traffic', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [] });
    adapter.listen(async () => 'never');
    await adapter.onActivity(activity());
    expect(calls.filter((c) => c.kind === 'reply')).toHaveLength(0);
  });

  it('gates group chats on the bot mention when respondWithoutMention is off, and strips it', async () => {
    const { adapter } = await makeAdapter({ respondWithoutMention: false, rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    const seen: string[] = [];
    adapter.listen(async (_src, text) => { seen.push(text); return undefined; });
    const group = (over: Record<string, unknown>) => activity({
      conversation: { id: 'a:g1', conversationType: 'groupChat', tenantId: 't' }, ...over,
    });
    await adapter.onActivity(group({ text: 'no mention here', entities: [] }));
    expect(seen).toHaveLength(0);
    await adapter.onActivity(group({
      text: '<at>Elowen</at> do the thing',
      entities: [{ type: 'mention', mentioned: { id: '28:bot', name: 'Elowen' } }],
    }));
    expect(seen).toEqual(['[Alex Rivera] do the thing']);
  });
});

describe('msteams live trace + cards + commands', () => {
  it('streams tool progress into an edited message when toolActivity is on', async () => {
    const { adapter, calls } = await makeAdapter({ toolActivity: 'status', rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'tool', name: 'Write', id: 't1', detail: 'a.ts', icon: '📝' });
      onEvent?.({ type: 'tool_end', id: 't1' });
      return 'all done';
    });
    await adapter.onActivity(activity());
    // A progress bubble was created and the final answer settled — both through the connector.
    const sends = calls.filter((c) => c.kind === 'send' || c.kind === 'reply');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const texts = sends.map((c) => (c.args[3] ?? c.args[2]) as { text?: string }).map((a) => a?.text ?? '');
    expect(texts.some((t) => t.includes('Write'))).toBe(true);
    expect(texts.some((t) => t.includes('all done'))).toBe(true);
  });

  it('renders an ask card, applies a single-select tap as the answer and settles the card', async () => {
    const answers: { id: string; answers: unknown[] }[] = [];
    const { adapter, state, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] }, { answers });
    // An ask always fires mid-turn, after the inbound activity stored the conversation route.
    state.patch('a:conv1', { ref: { serviceUrl: 'https://smba.test/emea' } });
    await adapter.postAsk('a:conv1', 'in-1', 'aad-1', 'ask-9', [
      { header: 'Approach', question: 'Which way?', multiSelect: false, options: [{ label: 'Fast' }, { label: 'Safe' }] },
    ]);
    const posted = calls.find((c) => c.kind === 'reply');
    const attachment = (posted?.args[3] as { attachments?: { content?: { actions?: unknown[]; body?: unknown[] } }[] })?.attachments?.[0];
    expect(attachment?.content?.body?.length).toBeGreaterThan(0);
    const token = [...adapter.pendingAsks.keys()][0]!;
    await adapter.onCardAction(activity({ value: { ea: token, q: 0, o: 1 } }));
    expect(answers).toEqual([{ id: 'ask-9', answers: [{ header: 'Approach', selected: ['Safe'] }] }]);
    expect(adapter.pendingAsks.size).toBe(0);
    expect(calls.some((c) => c.kind === 'update')).toBe(true); // the card settled to a summary
  });

  it('rejects an ask answer from someone else and expires stale asks', async () => {
    const answers: { id: string; answers: unknown[] }[] = [];
    const { adapter } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] }, { answers });
    await adapter.postAsk('a:conv1', 'in-1', 'aad-OWNER', 'ask-1', [
      { header: 'Q', question: '?', options: [{ label: 'A' }] },
    ]);
    const token = [...adapter.pendingAsks.keys()][0]!;
    // aad-1 is neither the asker nor an admin → the pick is refused and the ask stays pending.
    await adapter.onCardAction(activity({ value: { ea: token, q: 0, o: 0 } }));
    expect(answers).toHaveLength(0);
    expect(adapter.pendingAsks.size).toBe(1);
  });

  // Regression: the asker key was stored from the inbound activity but compared against a DIFFERENT
  // derived form on the way back, so a real Teams user — who always has an aadObjectId — could not
  // answer the question the turn had just asked THEM. Driving the whole path is the point of these
  // two: calling postAsk directly with a key of the test's choosing is what hid the bug.
  it('lets the asker answer the card their own turn opened (live stream on)', async () => {
    const answers: { id: string; answers: unknown[] }[] = [];
    const { adapter } = await makeAdapter(
      { toolActivity: 'status', rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] }, { answers },
    );
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'ask', id: 'ask-live', questions: [{ header: 'Q', question: '?', options: [{ label: 'A' }] }] });
      return 'done';
    });
    await adapter.onActivity(activity());
    const token = [...adapter.pendingAsks.keys()][0]!;
    await adapter.onCardAction(activity({ id: 'in-2', value: { ea: token, q: 0, o: 0 } }));
    expect(answers).toEqual([{ id: 'ask-live', answers: [{ header: 'Q', selected: ['A'] }] }]);
  });

  it('lets the asker answer the card their own turn opened (live stream off)', async () => {
    const answers: { id: string; answers: unknown[] }[] = [];
    const { adapter } = await makeAdapter(
      { toolActivity: 'off', answerMode: 'final', rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] }, { answers },
    );
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent?.({ type: 'ask', id: 'ask-plain', questions: [{ header: 'Q', question: '?', options: [{ label: 'A' }] }] });
      return 'done';
    });
    await adapter.onActivity(activity());
    const token = [...adapter.pendingAsks.keys()][0]!;
    await adapter.onCardAction(activity({ id: 'in-2', value: { ea: token, q: 0, o: 0 } }));
    expect(answers).toEqual([{ id: 'ask-plain', answers: [{ header: 'Q', selected: ['A'] }] }]);
  });

  it('handles /new and /status via the shared control core and /help locally', async () => {
    const { adapter, state, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', admin: true, projectIds: [] }] });
    adapter.listen(async () => 'unused');
    await adapter.onActivity(activity({ text: '/new' }));
    expect((state.get('a:conv1') as { gen?: number }).gen).toBe(1);
    await adapter.onActivity(activity({ text: '/status' }));
    await adapter.onActivity(activity({ text: '/help' }));
    const texts = calls.filter((c) => c.kind === 'reply').map((c) => (c.args[3] as { text?: string })?.text ?? '');
    expect(texts.some((t) => t.includes('Fresh conversation'))).toBe(true);
    expect(texts.some((t) => t.includes('No active conversation'))).toBe(true);
    expect(texts.some((t) => t.includes('Microsoft Teams'))).toBe(true);
  });

  it('posts the /model picker for an admin and applies the picked model', async () => {
    const models = [
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4-8', default: true },
      { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.5' },
    ];
    const { adapter, state, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', admin: true, projectIds: [] }] }, { models });
    adapter.listen(async () => 'unused');
    await adapter.onActivity(activity({ text: '/model' }));
    const card = calls.find((c) => c.kind === 'reply' && (c.args[3] as { attachments?: unknown[] })?.attachments);
    expect(card).toBeDefined();
    await adapter.onCardAction(activity({ value: { ep: 'model', v: 'openai gpt-5.5' } }));
    expect((state.get('a:conv1') as { model?: { provider: string; model: string } }).model)
      .toEqual({ provider: 'openai', model: 'gpt-5.5' });
  });

  it('refuses the /model picker for a non-admin sender', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] }, { models: [{ provider: 'a', providerLabel: 'A', model: 'm' }] });
    adapter.listen(async () => 'unused');
    await adapter.onActivity(activity({ text: '/model' }));
    const texts = calls.filter((c) => c.kind === 'reply').map((c) => (c.args[3] as { text?: string })?.text ?? '');
    expect(texts.some((t) => t.includes('operator'))).toBe(true);
  });
});

describe('msteams proactive notify + app package', () => {
  it('pushes to the configured notification conversation via its stored route', async () => {
    const { adapter, state, calls } = await makeAdapter({ notifyConversationId: 'a:conv1' });
    state.patch('a:conv1', { ref: { serviceUrl: 'https://smba.test/emea' } });
    await adapter.notify('nightly build done');
    const sent = calls.find((c) => c.kind === 'send');
    expect(sent?.args[0]).toBe('https://smba.test/emea');
    expect(sent?.args[2]).toMatchObject({ type: 'message', text: 'nightly build done' });
  });

  it('opens a personal conversation for an unseen user target and reuses it', async () => {
    const { adapter, state, calls } = await makeAdapter({});
    state.patch('_meta', { serviceUrl: 'https://smba.test/emea' });
    Object.assign(adapter.connector, {
      createConversation: async (...args: unknown[]) => { calls.push({ kind: 'create', args }); return 'a:new-1'; },
    });
    await adapter.notify('ping', 'aad-user-7');
    await adapter.notify('pong', 'aad-user-7');
    const creates = calls.filter((c) => c.kind === 'create');
    expect(creates).toHaveLength(1); // the opened conversation is cached
    expect(creates[0]!.args[1]).toMatchObject({ bot: { id: '28:app-guid' }, members: [{ id: 'aad-user-7' }], tenantId: 'tenant-guid' });
    const sends = calls.filter((c) => c.kind === 'send');
    expect(sends.map((c) => c.args[1])).toEqual(['a:new-1', 'a:new-1']);
  });

  it('stays silent before the bot has seen any serviceUrl', async () => {
    const { adapter, calls } = await makeAdapter({ notifyConversationId: 'a:conv1' });
    await adapter.notify('lost');
    expect(calls).toHaveLength(0);
  });

  it('builds a valid stored-ZIP app package with the Teams manifest and icons', async () => {
    const { adapter } = await makeAdapter({ agentName: 'Elowen' });
    const zip = adapter.appPackage();
    // Stored ZIP framing: local header signature, then name and raw (uncompressed) data.
    expect([...zip.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const nameLen = zip.readUInt16LE(26);
    const size = zip.readUInt32LE(18);
    expect(zip.subarray(30, 30 + nameLen).toString()).toBe('manifest.json');
    const manifest = JSON.parse(zip.subarray(30 + nameLen, 30 + nameLen + size).toString()) as {
      id: string; bots: { botId: string; scopes: string[]; commandLists: { commands: { title: string }[] }[] }[];
      icons: Record<string, string>;
    };
    expect(manifest.id).toBe('app-guid');
    expect(manifest.bots[0]).toMatchObject({ botId: 'app-guid', scopes: ['personal', 'team', 'groupChat'] });
    expect(manifest.bots[0]!.commandLists[0]!.commands.map((c) => c.title)).toContain('display');
    expect(manifest.icons).toEqual({ color: 'color.png', outline: 'outline.png' });
    // Both icons ride along as real PNGs (signature bytes present past the manifest entry).
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(zip.indexOf(pngSig)).toBeGreaterThan(0);
    expect(zip.indexOf(pngSig, zip.indexOf(pngSig) + 1)).toBeGreaterThan(zip.indexOf(pngSig));
    // Central directory + end-of-central-directory close the archive.
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('registers the Teams* chat tools when configured', async () => {
    const reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['msteams'], logger: log,
      config: { msteams: { ...CREDS, rolePolicies: [] } },
    });
    const names = reg.tools.map((t) => t.name);
    for (const n of ['TeamsSend', 'TeamsChatInfo', 'TeamsMembers', 'TeamsMemberInfo', 'TeamsListConversations', 'TeamsApi']) {
      expect(names).toContain(n);
    }
  });
});

describe('msteams webhook JWT validation', () => {
  it('accepts a properly signed token and rejects bad audience/issuer/none', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/metadata') res.end(JSON.stringify({ jwks_uri: `http://127.0.0.1:${port}/keys` }));
      else if (req.url === '/keys') res.end(JSON.stringify({ keys: [jwk] }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const { makeTokenVerifier } = await import(join(repoRoot, 'plugins/msteams/index.mjs')) as {
        makeTokenVerifier: (cfg: Record<string, unknown>, logger: typeof log) => (h: string | undefined, a: unknown) => Promise<boolean>;
      };
      const verify = makeTokenVerifier({ appId: CREDS.appId, openIdMetadataUrl: `http://127.0.0.1:${port}/metadata` }, log);
      const sign = (claims: Record<string, unknown>, aud = CREDS.appId, iss = 'https://api.botframework.com') =>
        new SignJWT({ serviceUrl: 'https://smba.test/emea', ...claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime('5m')
          .sign(privateKey);

      const act = { serviceUrl: 'https://smba.test/emea' };
      expect(await verify(`Bearer ${await sign({})}`, act)).toBe(true);
      expect(await verify(undefined, act)).toBe(false);
      expect(await verify('Bearer not-a-jwt', act)).toBe(false);
      expect(await verify(`Bearer ${await sign({}, 'other-bot')}`, act)).toBe(false);
      expect(await verify(`Bearer ${await sign({}, CREDS.appId, 'https://evil.example')}`, act)).toBe(false);
      // A token minted for another serviceUrl must not authorize this activity.
      expect(await verify(`Bearer ${await sign({ serviceUrl: 'https://smba.other/region' })}`, act)).toBe(false);
    } finally {
      server.close();
    }
  });

  it('answers 401 on the webhook for an unverified activity and 200 + async turn for a message', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    let allow = false;
    adapter.verifyToken = async () => allow;
    let turns = 0;
    adapter.listen(async () => { turns += 1; return 'ok'; });
    const req = { method: 'POST', headers: { authorization: 'Bearer x' }, json: async () => activity() };
    expect((await adapter.handleWebhook(req)).status).toBe(401);
    expect(turns).toBe(0);
    allow = true;
    expect((await adapter.handleWebhook(req)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // the turn runs detached from the webhook response
    expect(turns).toBe(1);
    expect(calls.some((c) => c.kind === 'reply')).toBe(true);
    expect((await adapter.handleWebhook({ ...req, method: 'GET' })).status).toBe(405);
  });
});

describe('msteams mentions + runtime footer', () => {
  const roster = [
    { id: '29:dana', name: 'Dana Novák', userPrincipalName: 'dana@contoso.com', aadObjectId: 'aad-2' },
    { id: '29:sam', name: 'Sam', userPrincipalName: 'sam@contoso.com' },
  ];

  it('hands an inbound mention of someone else to the model as a name, and drops its own', async () => {
    const { adapter } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    const seen: string[] = [];
    adapter.listen(async (_src, text) => { seen.push(text); return undefined; });
    await adapter.onActivity(activity({
      text: '<at>Elowen</at> ask <at>Dana Novák</at> about it',
      entities: [
        { type: 'mention', text: '<at>Elowen</at>', mentioned: { id: '28:bot', name: 'Elowen' } },
        { type: 'mention', text: '<at>Dana Novák</at>', mentioned: { id: '29:dana', name: 'Dana Novák' } },
      ],
    }));
    expect(seen).toEqual(['[Alex Rivera] ask @Dana Novák about it']);
  });

  it('rings a real member for both <@…> and a bare @name, and leaves a stranger as plain text', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    Object.assign(adapter.connector, { members: async () => roster });
    adapter.listen(async () => 'ping <@dana@contoso.com> and @Dana Novák, but not @Nobody Here');
    await adapter.onActivity(activity());
    const sent = calls.find((c) => c.kind === 'reply')?.args[3] as {
      text: string; entities?: { type: string; text: string; mentioned: { id: string; name: string } }[];
    };
    expect(sent.text).toBe('ping <at>Dana Novák</at> and <at>Dana Novák</at>, but not @Nobody Here');
    expect(sent.entities).toEqual([
      { type: 'mention', text: '<at>Dana Novák</at>', mentioned: { id: '29:dana', name: 'Dana Novák' } },
    ]);
  });

  it('declares no mention entity when the answer names nobody in the conversation', async () => {
    const { adapter, calls } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    Object.assign(adapter.connector, { members: async () => roster });
    adapter.listen(async () => 'mail me at ops@contoso.com');
    await adapter.onActivity(activity());
    const sent = calls.find((c) => c.kind === 'reply')?.args[3] as { text: string; entities?: unknown[] };
    expect(sent.text).toBe('mail me at ops@contoso.com');
    expect(sent.entities).toBeUndefined();
  });

  it('sets the runtime footer apart as a dashed italic line, never a quoted block', async () => {
    const { footerLine } = await import(join(repoRoot, 'plugins/msteams/lib/format.mjs')) as {
      footerLine: (idle: unknown) => string;
    };
    const line = footerLine({ model: 'openai/gpt-5', usage: { percent: 42 } });
    // The leading nbsp paragraph is the gap: Teams renders the engine's own blank-line join tight, and
    // an empty paragraph is dropped by markdown, so the spacer must carry a character that looks blank.
    expect(line).toBe('\u00a0\n\n*— gpt-5 · 42 %*');
    expect(line.split('\n').at(-1)).toBe('*— gpt-5 · 42 %*');
    // Teams draws a blockquote as a full-width bordered strip that dwarfs a one-line footer, and a `* `
    // opener would turn the line into a bullet item.
    expect(line.startsWith('>')).toBe(false);
    expect(line.startsWith('* ')).toBe(false);
    expect(footerLine({})).toBe('');
  });
});

describe('msteams conversation history backfill', () => {
  const policy = { rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] };

  it('records nothing and offers no context while the backfill is off', async () => {
    const { adapter, state } = await makeAdapter(policy);
    const srcs: Record<string, unknown>[] = [];
    adapter.listen(async (src) => { srcs.push(src); return 'ok'; });
    await adapter.onActivity(activity());
    // Off is the default, and off must mean nothing is written to disk at all — this transcript persists
    // message text, unlike Discord's fetch-on-demand.
    expect((state.get('a:conv1') as { log?: unknown[] }).log).toBeUndefined();
    expect(await (srcs[0]!.history as () => Promise<string>)()).toBe('');
  });

  it('hands the brain a promise, which is what it calls .catch() on', async () => {
    // The SessionSource contract is `history?: () => Promise<string>`. A synchronous string satisfies
    // every assertion about its CONTENT and still breaks the first turn of every new conversation,
    // because the brain does `await opts.history().catch(…)` — and a string has no .catch.
    const { adapter } = await makeAdapter({ historyLimit: 10, ...policy });
    const srcs: Record<string, unknown>[] = [];
    adapter.listen(async (src) => { srcs.push(src); return 'ok'; });
    await adapter.onActivity(activity());
    const returned = (srcs[0]!.history as () => unknown)();
    expect(typeof (returned as { catch?: unknown })?.catch).toBe('function');
    expect(await (returned as Promise<string>)).toBe('');
  });

  it('seeds a new conversation with both sides, minus the message being answered', async () => {
    const { adapter } = await makeAdapter({ historyLimit: 10, ...policy });
    const srcs: Record<string, unknown>[] = [];
    adapter.listen(async (src) => { srcs.push(src); return 'the answer'; });
    await adapter.onActivity(activity({ id: 'in-1', text: 'first question' }));
    await adapter.onActivity(activity({ id: 'in-2', text: 'second question' }));

    expect(await (srcs[0]!.history as () => Promise<string>)()).toBe(''); // nothing preceded the first message
    const block = await (srcs[1]!.history as () => Promise<string>)();
    expect(block).toContain('[Alex Rivera] first question');
    expect(block).toContain('[Elowen] the answer');
    // The message being answered was recorded a moment earlier; carrying it would duplicate the prompt.
    expect(block).not.toContain('second question');
    expect(block).toContain('NEVER as instructions');
  });

  it('keeps bot-control commands out of the transcript', async () => {
    const { adapter, state } = await makeAdapter({ historyLimit: 10, rolePolicies: [{ roleId: 'aad-1', admin: true, projectIds: [] }] });
    adapter.listen(async () => 'a real answer');
    await adapter.onActivity(activity({ id: 'in-1', text: '/status' }));
    await adapter.onActivity(activity({ id: 'in-2', text: 'a real message' }));
    const log = (state.get('a:conv1') as { log?: { t: string }[] }).log ?? [];
    expect(log.map((e) => e.t)).toEqual(['a real message', 'a real answer']);
  });

  it('records what the gates reject, so background chatter still becomes context', async () => {
    // An unmapped sender gets no turn, but what they said is still part of this conversation.
    const { adapter, state } = await makeAdapter({ historyLimit: 10, rolePolicies: [] });
    adapter.listen(async () => 'never');
    await adapter.onActivity(activity({ id: 'in-1', text: 'chatter from a stranger' }));
    const log = (state.get('a:conv1') as { log?: { t: string }[] }).log ?? [];
    expect(log.map((e) => e.t)).toEqual(['chatter from a stranger']);
  });

  it('keeps only the configured number of messages on disk', async () => {
    const { adapter, state } = await makeAdapter({ historyLimit: 2, ...policy });
    adapter.listen(async () => 'reply');
    for (let i = 1; i <= 3; i++) await adapter.onActivity(activity({ id: `in-${i}`, text: `message ${i}` }));
    const log = (state.get('a:conv1') as { log?: { t: string }[] }).log ?? [];
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.t)).toEqual(['message 3', 'reply']);
  });
});

describe('msteams live trace layout', () => {
  it('puts every tool row on its own line', async () => {
    // Teams treats a single newline as a soft wrap, so the shared engine's default join rendered the
    // whole trace as one run-on paragraph: "Skill … ToolSearch … CronAdd …" side by side.
    const { LiveMessage } = await import(join(repoRoot, 'plugins/msteams/lib/stream.mjs')) as {
      LiveMessage: new (a: unknown, c: string, r?: string, k?: string, d?: unknown) => {
        onEvent: (e: Record<string, unknown>) => void;
      };
    };
    let content = '';
    const adapter = {
      cfg: { runtimeFooter: false },
      tmSend: async (_c: string, text: string) => { content = text; return 'mid-1'; },
      tmEdit: async (_c: string, _id: string, text: string) => { content = text; return true; },
      tmDelete: async () => true,
    };
    const lm = new LiveMessage(adapter, 'a:conv1');
    lm.onEvent({ type: 'tool', id: 'a', name: 'Skill', detail: 'skills', icon: '📚' });
    lm.onEvent({ type: 'tool', id: 'b', name: 'CronAdd', detail: 'every minute', icon: '⏰' });
    await new Promise((r) => setTimeout(r, 30));

    const rows = content.split('\n').filter((l) => l.trim());
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.some((l) => l.includes('Skill') && l.includes('CronAdd'))).toBe(false);
    expect(content).toContain('\n\n');
  });
});

describe('msteams per-chat overrides', () => {
  it('offers a default choice on every /display axis so an override can be taken back off', async () => {
    const { adapter, state } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', admin: true, projectIds: [] }] });
    adapter.listen(async () => 'unused');
    await adapter.onActivity(activity({ text: '/display' }));
    const options = (adapter.pendingPickers.get('a:conv1') as { options: { value: string }[] }).options;
    for (const axis of ['toolActivity', 'answerMode', 'toolOutput', 'toolMessageMode']) {
      expect(options.some((o) => o.value === `${axis} default`)).toBe(true);
    }
    await adapter.onCardAction(activity({ value: { ep: 'display', v: 'toolActivity off' } }));
    expect((state.get('a:conv1') as { display?: Record<string, string> }).display).toEqual({ toolActivity: 'off' });
    await adapter.onActivity(activity({ text: '/display' }));
    await adapter.onCardAction(activity({ value: { ep: 'display', v: 'toolActivity default' } }));
    expect((state.get('a:conv1') as { display?: Record<string, string> }).display).toEqual({});
  });

  it('clears fast when the picked model does not offer it', async () => {
    const models = [
      { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5.5', fastAvailable: true, default: true },
      { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4-8' },
    ];
    const { adapter, state } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', admin: true, projectIds: [] }] }, { models });
    adapter.listen(async () => 'unused');
    state.patch('a:conv1', { fast: true });
    await adapter.onActivity(activity({ text: '/model' }));
    await adapter.onCardAction(activity({ value: { ep: 'model', v: 'anthropic claude-opus-4-8' } }));
    // Fast is a provider capability, not a portable preference: it must not survive the move.
    expect(state.get('a:conv1')).toMatchObject({ model: { provider: 'anthropic', model: 'claude-opus-4-8' }, fast: false });
  });

  it('says so when a proactive push has nowhere to go', async () => {
    // A cron job that names no channel delivers through notify(). With no notifyConversationId either,
    // the push was dropped in silence — a result the scheduler already paid a real turn for, gone every
    // run with nothing anywhere to show for it.
    const { adapter, calls, warnings } = await makeAdapter({ rolePolicies: [] });
    await adapter.notify('08:04:01', '', undefined);
    expect(calls.filter((c) => c.kind === 'reply')).toHaveLength(0);
    expect(warnings.some((w) => w.includes('notifyConversationId'))).toBe(true);
  });

  it('logs a failed turn as well as replying with it', async () => {
    // Replying only would leave the failure visible to the one person who asked, and to no operator:
    // the daemon log would show a healthy service while every turn died in the chat.
    const { adapter, calls, errors } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    adapter.listen(async () => { throw new Error('brain exploded'); });
    await adapter.onActivity(activity());
    const replies = calls.filter((c) => c.kind === 'reply').map((c) => (c.args[3] as { text?: string })?.text ?? '');
    expect(replies.some((t) => t.includes('brain exploded'))).toBe(true);
    expect(errors.some((e) => e.includes('brain exploded') && e.includes('a:conv1'))).toBe(true);
  });

  it('drops a question that timed out instead of leaving its card answerable', async () => {
    const { adapter } = await makeAdapter({ askTimeoutMs: 30000, rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    adapter.listen(async () => 'ok');
    await adapter.postAsk('a:conv1', 'in-0', 'aad-1', 'q-1', [{ header: 'Colour', options: [{ label: 'Blue' }] }]);
    expect(adapter.pendingAsks.size).toBe(1);
    for (const pend of adapter.pendingAsks.values()) pend.createdAt = Date.now() - 60000;
    await adapter.onActivity(activity({ id: 'in-9', text: 'something unrelated' }));
    expect(adapter.pendingAsks.size).toBe(0);
  });
});

describe('msteams proactive person messaging', () => {
  // Two people share a first name on purpose: "Dana" must never be guessed.
  const roster = [
    { id: '29:dana', name: 'Dana Novák', userPrincipalName: 'dana@contoso.com', aadObjectId: 'aad-2' },
    { id: '29:danam', name: 'Dana Malá', userPrincipalName: 'dana.mala@contoso.com', aadObjectId: 'aad-3' },
    { id: '29:sam', name: 'Sam', userPrincipalName: 'sam@contoso.com', aadObjectId: 'aad-4' },
  ];

  /** An adapter that has met the roster of a team channel — the layer-1 case: no Graph anywhere. */
  async function withRoster(cfg: Record<string, unknown> = {}) {
    const made = await makeAdapter(cfg);
    made.state.patch('_meta', { serviceUrl: 'https://smba.test/emea' });
    made.state.patch('a:team', { ref: { serviceUrl: 'https://smba.test/emea', conversationType: 'channel' } });
    Object.assign(made.adapter.connector, {
      members: async () => roster,
      createConversation: async (...args: unknown[]) => { made.calls.push({ kind: 'create', args }); return 'a:dm-dana'; },
    });
    await made.adapter.readRoster('a:team');
    return made;
  }

  it('learns people from a roster and resolves them by e-mail, Entra id and exact name', async () => {
    const { adapter } = await withRoster();
    expect(adapter.lookupPeople('dana@contoso.com')).toMatchObject([{ aad: 'aad-2', id: '29:dana', name: 'Dana Novák' }]);
    expect(adapter.lookupPeople('aad-3')).toMatchObject([{ name: 'Dana Malá' }]);
    expect(adapter.lookupPeople('29:sam')).toMatchObject([{ name: 'Sam' }]);
    expect(adapter.lookupPeople('Dana Novák')).toMatchObject([{ aad: 'aad-2' }]);
    // A channel roster is not a route TO anyone: the personal chat still has to be opened.
    expect(adapter.lookupPeople('Sam')[0]!.conv).toBeUndefined();
  });

  it('learns the personal chat straight from an inbound activity, so it never needs opening', async () => {
    const { adapter } = await makeAdapter({ rolePolicies: [{ roleId: 'aad-1', projectIds: [] }] });
    adapter.listen(async () => 'ok');
    await adapter.onActivity(activity());
    // from + conversationType 'personal' + the roster's UPN — the whole address in one message.
    expect(adapter.lookupPeople('alex@contoso.com')).toMatchObject([
      { aad: 'aad-1', id: '29:enc', name: 'Alex Rivera', conv: 'a:conv1' },
    ]);
  });

  it('refuses an ambiguous name with its candidates and sends nothing', async () => {
    const { adapter, calls } = await withRoster();
    await expect(adapter.messagePerson({ name: 'Dana' }, 'the build broke')).rejects.toThrow(/matches 2 people/);
    const message = await adapter.messagePerson({ name: 'Dana' }, 'x').catch((e: Error) => e.message);
    expect(message).toContain('Dana Novák');
    expect(message).toContain('Dana Malá');
    expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
  });

  it('opens the 1:1 chat on the first message and reuses it on the second', async () => {
    const { adapter, calls } = await withRoster();
    const first = await adapter.messagePerson({ email: 'dana@contoso.com' }, 'the build broke');
    expect(first.conversationId).toBe('a:dm-dana');
    const creates = calls.filter((c) => c.kind === 'create');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args[1]).toEqual({
      bot: { id: '28:app-guid' },
      members: [{ id: '29:dana' }],
      channelData: { tenant: { id: 'tenant-guid' } },
      tenantId: 'tenant-guid',
      isGroup: false,
    });
    const sent = calls.filter((c) => c.kind === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[0]).toBe('https://smba.test/emea');
    expect(sent[0]!.args[1]).toBe('a:dm-dana');
    expect(sent[0]!.args[2]).toMatchObject({ type: 'message', text: 'the build broke' });

    // Second time, addressed differently — the remembered conversation is used, nothing is opened.
    await adapter.messagePerson({ name: 'Dana Novák' }, 'and now it is green');
    expect(calls.filter((c) => c.kind === 'create')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'send')).toHaveLength(2);
  });

  it('tells an operator how to make an unknown person reachable, and calls no Graph', async () => {
    const { adapter, calls } = await withRoster();
    const fetched = stubFetch(() => undefined);
    try {
      const message = await adapter.messagePerson({ email: 'michal@contoso.com' }, 'hi').catch((e: Error) => e.message);
      expect(message).toContain('does not know anyone matching "michal@contoso.com"');
      expect(message).toContain('send the bot one direct message');
      expect(message).toContain('TeamsMembers');
      expect(message).toContain('Microsoft Graph lookup');
      expect(fetched.seen).toHaveLength(0); // layer 2 is off: nothing left this process
      expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
    } finally {
      fetched.restore();
    }
  });

  it('resolves an unseen e-mail through Graph, installs the app and then opens the chat', async () => {
    const { adapter, state, calls } = await makeAdapter({ graphLookup: true, graphCatalogAppId: 'catalog-1' });
    state.patch('_meta', { serviceUrl: 'https://smba.test/emea' });
    Object.assign(adapter.connector, {
      createConversation: async (...args: unknown[]) => { calls.push({ kind: 'create', args }); return 'a:dm-michal'; },
    });
    const fetched = stubFetch((url, method) => {
      if (url === TOKEN_URL) return { status: 200, body: { access_token: 'graph-tok', expires_in: 3600 } };
      if (method === 'GET' && url.includes('/users/michal%40contoso.com')) {
        return { status: 200, body: { id: 'aad-9', displayName: 'Michal Král', userPrincipalName: 'michal@contoso.com' } };
      }
      if (method === 'POST' && url.endsWith('/users/aad-9/teamwork/installedApps')) return { status: 201, body: {} };
      return undefined;
    });
    try {
      const out = await adapter.messagePerson({ email: 'michal@contoso.com' }, 'deploy finished');
      expect(out.conversationId).toBe('a:dm-michal');
      const graph = fetched.seen.filter((c) => c.url.startsWith('https://graph.microsoft.com'));
      expect(graph.map((c) => `${c.method} ${c.url.replace('https://graph.microsoft.com/v1.0', '')}`)).toEqual([
        'GET /users/michal%40contoso.com?$select=id,displayName,userPrincipalName,mail',
        'POST /users/aad-9/teamwork/installedApps',
      ]);
      expect(JSON.parse(graph[1]!.body!)).toEqual({
        'teamsApp@odata.bind': 'https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/catalog-1',
      });
      expect(calls.filter((c) => c.kind === 'create')[0]!.args[1]).toMatchObject({ members: [{ id: 'aad-9' }] });
      expect(calls.filter((c) => c.kind === 'send')[0]!.args[2]).toMatchObject({ text: 'deploy finished' });
      // The person is now known locally: the next message costs no Graph call at all.
      expect(adapter.lookupPeople('michal@contoso.com')).toMatchObject([{ aad: 'aad-9', conv: 'a:dm-michal' }]);
    } finally {
      fetched.restore();
    }
  });

  it('translates a missing Graph consent into what the admin has to grant', async () => {
    const { adapter, calls } = await makeAdapter({ graphLookup: true, graphCatalogAppId: 'catalog-1' });
    const fetched = stubFetch((url) => {
      if (url === TOKEN_URL) return { status: 200, body: { access_token: 'graph-tok', expires_in: 3600 } };
      return { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges.' } } };
    });
    try {
      const message = await adapter.messagePerson({ email: 'michal@contoso.com' }, 'hi').catch((e: Error) => e.message);
      expect(message).toContain('User.ReadBasic.All');
      expect(message).toContain('Grant admin consent');
      expect(message).toContain('App registrations');
      expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
    } finally {
      fetched.restore();
    }
  });

  it('lets a scheduled push address a person instead of a conversation id', async () => {
    const { adapter, calls } = await withRoster();
    await adapter.notify('nightly build done', 'dana@contoso.com');
    await adapter.notify('and the second run too', 'dana@contoso.com');
    expect(calls.filter((c) => c.kind === 'create')).toHaveLength(1);
    const sent = calls.filter((c) => c.kind === 'send');
    expect(sent.map((c) => c.args[1])).toEqual(['a:dm-dana', 'a:dm-dana']);
    expect(sent[0]!.args[2]).toMatchObject({ text: 'nightly build done' });
  });

  it('drops an ambiguous scheduled push with a warning rather than picking someone', async () => {
    const { adapter, calls, warnings } = await withRoster();
    await adapter.notify('who gets this?', 'Dana');
    expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
    expect(warnings.some((w) => w.includes('matches 2 people'))).toBe(true);
  });
});

describe('msteams person tools gating', () => {
  const roster = [{ id: '29:dana', name: 'Dana Novák', userPrincipalName: 'dana@contoso.com', aadObjectId: 'aad-2' }];

  async function known(cfg: Record<string, unknown> = {}) {
    const made = await makeAdapter(cfg);
    made.state.patch('_meta', { serviceUrl: 'https://smba.test/emea' });
    made.state.patch('a:team', { ref: { serviceUrl: 'https://smba.test/emea', conversationType: 'channel' } });
    Object.assign(made.adapter.connector, {
      members: async () => roster,
      createConversation: async (...args: unknown[]) => { made.calls.push({ kind: 'create', args }); return 'a:dm-dana'; },
    });
    await made.adapter.readRoster('a:team');
    return made;
  }

  it('refuses TeamsMessagePerson for a non-operator and sends nothing', async () => {
    const { adapter, calls } = await known();
    const { run } = await makeTools(adapter, { admin: true, owner: false });
    const out = await run('TeamsMessagePerson', { email: 'dana@contoso.com', text: 'unsolicited' });
    expect(out).toContain('only available to the operator');
    expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
  });

  it('refuses TeamsFindPerson outside an admin session', async () => {
    const { adapter } = await known();
    const { run } = await makeTools(adapter, { admin: false, owner: false });
    expect(await run('TeamsFindPerson', { query: 'dana' })).toContain('admin session');
  });

  it('sends for the operator and reports the person and the chat', async () => {
    const { adapter, calls } = await known();
    const { run } = await makeTools(adapter, { admin: true, owner: true });
    expect(await run('TeamsMessagePerson', { email: 'dana@contoso.com', text: 'the build broke' }))
      .toBe('Sent to Dana Novák (chat a:dm-dana).');
    expect(calls.filter((c) => c.kind === 'send')).toHaveLength(1);
  });

  it('requires a named recipient and never guesses one', async () => {
    const { adapter, calls } = await known();
    const { run } = await makeTools(adapter, { admin: true, owner: true });
    expect(await run('TeamsMessagePerson', { text: 'to whom?' })).toContain('name the recipient');
    expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
  });

  it('looks a person up read-only, and guides when nobody matches', async () => {
    const { adapter, calls } = await known();
    const { run } = await makeTools(adapter, { admin: true, owner: false });
    const found = await run('TeamsFindPerson', { query: 'dana@contoso.com' });
    expect(found).toContain('Dana Novák');
    expect(found).toContain('chat: not opened yet');
    expect(await run('TeamsFindPerson', { query: 'nobody@contoso.com' })).toContain('does not know anyone');
    expect(calls.filter((c) => c.kind === 'send' || c.kind === 'create')).toHaveLength(0);
  });

  it('never leaks the app password into tool output, the log or the state file', async () => {
    const { adapter, state, calls, errors, warnings } = await known({ graphLookup: true, graphCatalogAppId: 'catalog-1' });
    const { run } = await makeTools(adapter, { admin: true, owner: true });
    const fetched = stubFetch((url) => (url === TOKEN_URL
      ? { status: 401, body: { error: 'invalid_client', error_description: 'secret is wrong' } }
      : undefined));
    let outputs: string[] = [];
    try {
      outputs = [
        await run('TeamsFindPerson', { query: 'dana@contoso.com' }),
        await run('TeamsMessagePerson', { email: 'dana@contoso.com', text: 'ok' }),
        await run('TeamsMessagePerson', { email: 'stranger@contoso.com', text: 'hi' }), // drives the Graph path
      ];
    } finally {
      fetched.restore();
    }
    // Tool output, the daemon log, everything persisted, and every outbound connector payload.
    const persisted = JSON.stringify(state.data);
    const outbound = JSON.stringify(calls);
    for (const text of [...outputs, ...errors, ...warnings, persisted, outbound]) {
      expect(text).not.toContain(CREDS.appPassword);
    }
  });
});
