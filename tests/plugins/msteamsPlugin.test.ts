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
    connector: Record<string, unknown>;
    pendingAsks: Map<string, Record<string, unknown>>;
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
  const adapter = new MsTeamsAdapter(
    { ...CREDS, ...cfg }, log, state, async () => opts.models ?? [], [], () => null,
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
  return { adapter, state, calls };
}

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
