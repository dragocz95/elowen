import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { LiveEventReplay } from '../../src/brain/session/liveEventReplay.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { CardRegistry } from '../../src/brain/cards.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { PluginHook } from '../../src/plugins/api.js';

/** Same minimal fake LiveBrain the other channel suites use — only what send() touches. */
function fakeBrain(sessionId: string) {
  const messages: { role?: string; content?: unknown }[] = [];
  const session = {
    isStreaming: false,
    getContextUsage: () => ({ tokens: 50, contextWindow: 8000, percent: 1 }),
    messages,
    promptTemplates: [] as { name: string }[],
    prompt: vi.fn(async (t: string) => { messages.push({ role: 'assistant', content: `re: ${t}` }); }),
    steer: vi.fn(async () => {}),
    dispose: vi.fn(() => {}),
    getAllTools: () => [] as { name: string }[],
    getActiveToolNames: () => [] as string[],
    setActiveToolsByName: () => {},
  };
  const listeners = new Set<(e: BrainEvent) => void>();
  return {
    session, sessionId, ownerUserId: 1, model: 'kimi', thinkingLevel: undefined as string | undefined,
    providerId: 'moonshot', direct: false, requestProfile: { fast: false }, fastAvailable: false,
    thinkingLabels: {}, pluginToolNames: new Set<string>(),
    turnSender: undefined as number | undefined, interactedAt: undefined as number | undefined,
    turnRecallUserId: undefined as number | null | undefined,
    listeners, replay: new LiveEventReplay(listeners), turnContext: () => ({ beforeUser: '', afterUser: '' }),
  };
}
type Brain = ReturnType<typeof fakeBrain>;

function setup(deps: Record<string, unknown> = {}, channelId = 'discord-ctx') {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<Brain>();
  const cards = new CardRegistry(() => store);
  const spawn = vi.fn(async (o: { sessionId: string; ownerUserId: number }) => {
    if (!store.getSession(o.sessionId)) {
      store.createSession({ id: o.sessionId, userId: o.ownerUserId, model: 'kimi' });
    }
    return fakeBrain(o.sessionId);
  });
  const svc = new ChannelSessionService({
    registry, store, cards, users: { get: () => ({ username: 'o' }) }, spawn, ...deps,
  } as never);
  const sessionId = channelSessionId(channelId);
  const opts = {
    channelId, ownerUserId: 1,
    policy: { allowedProjectIds: 'all' as const, allowedPaths: () => [] },
    identity: { userId: 7 },
  };
  const promptOf = (): string => registry.channelGet(channelId)!.session.prompt.mock.calls.at(-1)![0] as string;
  return { store, registry, svc, sessionId, opts, promptOf };
}

describe('a channel turn carries the same per-turn context as an owner chat', () => {
  // A plugin's appendContext used to reach the CLI and web and silently skip every platform room, because
  // the room composed its own prompt and never emitted the hook. The plugin could not tell, and neither
  // could the person whose room it was.
  it('emits brain.turn.contextBuilt so a plugin can add context to a room', async () => {
    const hooks: PluginHook[] = [
      { name: 'brain.turn.contextBuilt', run: () => ({ patch: { appendContext: 'TODAY IS TUESDAY' } }) },
    ];
    const { svc, opts, promptOf } = setup({
      plugins: async () => ({
        hooks,
        hookOwners: ['calendar'],
        pluginCapabilities: new Map([['calendar', { mutates: ['turnContext'] }]]),
      }),
    });

    await svc.send(opts, 'what is on today?');

    const prompt = promptOf();
    expect(prompt).toContain('TODAY IS TUESDAY');
    // Plugin output is context, never instruction — on every surface, not just the owner's.
    expect(prompt).toContain('<plugin_context>');
    // Still ahead of the user's own words, exactly where the owner chat puts it.
    expect(prompt.indexOf('TODAY IS TUESDAY')).toBeLessThan(prompt.indexOf('what is on today?'));
  });

  it('leaves the prompt alone when no plugin contributes anything', async () => {
    const { svc, opts, promptOf } = setup({ plugins: async () => ({ hooks: [], hookOwners: [], pluginCapabilities: new Map() }) });

    await svc.send(opts, 'plain question');

    expect(promptOf()).not.toContain('<plugin_context>');
  });

  // A room's turns are minutes apart with other people's messages in between, so an agent that delegated
  // from a channel needs this reminder more than the owner chat does — and used to be the one surface
  // that never got it.
  it('reminds the agent that the job it delegated from this room is still running', async () => {
    const { store, registry, svc, sessionId, opts, promptOf } = setup({}, 'discord-children');

    await svc.send(opts, 'first');
    store.createSession({ id: 'brain-child-1', userId: 1, model: 'kimi', parentSessionId: sessionId });
    store.upsertSubagentRun(sessionId, {
      id: 'call-1', sessionId: 'brain-child-1', status: 'running',
      task: 'audit the invoices', tools: 3, seconds: 12, model: 'kimi',
    });
    registry.setChildRunning(sessionId, 'brain-child-1', true);

    await svc.send(opts, 'any news?');

    const prompt = promptOf();
    expect(prompt).toContain('<running-subagents>');
    expect(prompt).toContain('audit the invoices');
    expect(prompt).toContain('Do not duplicate or abort them');
    // Volatile per-turn reminder: it rides UNDER the message so it cannot invalidate the cached prefix.
    expect(prompt.indexOf('<running-subagents>')).toBeGreaterThan(prompt.indexOf('any news?'));
  });

  it('says nothing about sub-agents when the room has none running', async () => {
    const { svc, opts, promptOf } = setup({}, 'discord-nochildren');

    await svc.send(opts, 'hello');

    expect(promptOf()).not.toContain('<running-subagents>');
  });
});

/** A non-image attachment used to reach a room turn as the text note `[Attachment: x.pdf (…)]` — the agent
 *  was told a file existed and given no way to open it, while the same file dropped into the web chat
 *  became a real path in the sender's project. The room now takes that same upload path. */
describe('a room attachment reaches the turn as a real path', () => {
  const projectDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-room-turn-upload-'));
    tempDirs.push(dir);
    return dir;
  };
  const tempDirs: string[] = [];
  afterEach(() => { for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const uploadsFor = (root: string) => ({
    projects: { list: () => [{ id: 1, slug: 'workspace', path: root }] },
    userProjects: { forUser: () => [1] },
    users: { get: () => ({ username: 'patricie', is_admin: false }) },
    projectPath: () => root,
  });

  it('writes the file and puts its path in both the model prompt and the durable row', async () => {
    const root = projectDir();
    const { svc, opts, promptOf, store, sessionId } = setup({ uploads: uploadsFor(root) }, 'discord-attach');

    await svc.send(
      { ...opts, writerUserId: 7, attachments: [{ name: 'smlouva.pdf', data: Buffer.from('PDF').toString('base64'), mimeType: 'application/pdf' }] },
      'co je v té smlouvě?',
    );

    const prompt = promptOf();
    const stored = join(root, 'uploads', 'patricie');
    expect(prompt).toContain('co je v té smlouvě?');
    expect(prompt).toContain('smlouva.pdf (application/pdf) — saved to');
    expect(prompt).toContain(stored);
    // The durable row must carry the same path, or a reload strands the agent with a file it cannot find.
    const rows = store.getMessages(sessionId);
    expect(JSON.stringify(rows)).toContain(stored);
  });

  it('refuses out loud instead of dropping a file it cannot place', async () => {
    const root = projectDir();
    const { svc, opts } = setup({ uploads: uploadsFor(root) }, 'discord-attach-unlinked');

    // No verified writer: an unlinked sender's bytes must not enter anybody's project.
    await expect(svc.send(
      { ...opts, attachments: [{ name: 'a.pdf', data: Buffer.from('x').toString('base64') }] },
      'tady to máš',
    )).rejects.toThrow(/verified sender/);
  });

  /** A room member an administrator never assigned a project used to LOSE THEIR WHOLE TURN over this:
   *  storeChannelAttachments runs before any admission check, the refusal propagated all the way out to the
   *  adapter's catch, and the answer they would have got was replaced by an error about somebody else's
   *  configuration. Before room attachments could be stored at all, that same person got their answer plus
   *  a note. So a PLACEMENT problem degrades back to the note; a SECURITY refusal still throws (above). */
  it('still answers a writer with no assigned project, carrying the file as a note instead', async () => {
    const root = projectDir();
    const unassigned = { ...uploadsFor(root), userProjects: { forUser: () => [] as number[] } };
    const { svc, opts, promptOf } = setup({ uploads: unassigned }, 'discord-attach-unassigned');

    const reply = await svc.send(
      { ...opts, writerUserId: 7, attachments: [{ name: 'smlouva.pdf', data: Buffer.from('PDF').toString('base64'), mimeType: 'application/pdf' }] },
      'co je v té smlouvě?',
    );

    expect(reply).toBeTruthy(); // the turn ran; the sender was not handed an error instead of an answer
    const prompt = promptOf();
    expect(prompt).toContain('co je v té smlouvě?');
    expect(prompt).toContain('[Attachment: smlouva.pdf (application/pdf) — not saved: no project to upload into');
    expect(prompt).not.toContain('saved to'); // no path is claimed for a file that was never written
  });

  it('still answers when one attachment is empty, and writes the ones beside it', async () => {
    const root = projectDir();
    const { svc, opts, promptOf } = setup({ uploads: uploadsFor(root) }, 'discord-attach-empty');

    const reply = await svc.send(
      { ...opts, writerUserId: 7, attachments: [
        { name: 'empty.pdf', data: '' },
        { name: 'smlouva.pdf', data: Buffer.from('PDF').toString('base64'), mimeType: 'application/pdf' },
      ] },
      'co je v té smlouvě?',
    );

    expect(reply).toBeTruthy();
    const prompt = promptOf();
    expect(prompt).toContain('[Attachment: empty.pdf — not saved: the file arrived empty]');
    expect(prompt).toContain('smlouva.pdf (application/pdf) — saved to');
  });
});
