import { describe, it, expect, vi } from 'vitest';
import { BrainService } from '../../src/brain/brainService.js';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

function fakeDeps() {
  const listeners: ((e: unknown) => void)[] = [];
  const messages: { role: string; content: string }[] = [];
  const session = {
    sessionId: 'sess-1',
    prompt: vi.fn(async (t: string) => {
      messages.push({ role: 'user', content: t }, { role: 'assistant', content: `echo:${t}` });
      listeners.forEach((l) => l({ type: 'agent_end', willRetry: false, messages: [{ role: 'assistant', content: `echo:${t}` }] }));
    }),
    subscribe: (l: (e: unknown) => void) => { listeners.push(l); return () => {}; },
    setModel: vi.fn(), dispose: vi.fn(), messages, isStreaming: false,
    getContextUsage: () => undefined, compact: vi.fn(async () => {}),
  };
  const createSession = vi.fn(async () => ({ session }));
  return {
    store: new BrainStore(openDb(':memory:')),
    users: { ensureAdvisorToken: () => 'full-token', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai' as const, baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: vi.fn((name: string, vars: Record<string, string>) => `PERSONA:${name}:${vars.userName}`) },
    url: 'http://x',
    createSession,
    resourceLoaderFactory: () => undefined,
    session,
  };
}

describe('BrainService', () => {
  it('start creates a session row and reports running', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const { sessionId } = await svc.start(1);
    expect(sessionId).toBe('brain-1');
    expect(svc.status(1).running).toBe(true);
    expect(d.store.getSession('brain-1')).toBeDefined();
    expect(d.createSession).toHaveBeenCalledTimes(1);
    expect(d.prompts.render).toHaveBeenCalledWith('advisor', { userName: 'Filip' }, 1);
  });

  it('composes plugin tools and appends plugin fragments to the persona', async () => {
    const d = fakeDeps();
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', {}, { info() {}, warn() {}, error() {} });
    ctx.registerTool(defineTool({
      name: 'demo_echo', label: 'Echo', description: 'echo', parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }),
    }));
    ctx.registerSystemPromptFragment('Follow house style.');
    (d as unknown as { plugins: PluginRegistry }).plugins = reg;
    (d as unknown as { policy: () => unknown }).policy = () => ({ allowedProjectIds: 'all', allowedPaths: () => [] });
    let seenAppend: string[] | undefined;
    d.resourceLoaderFactory = (o: { appendSystemPrompt?: string[] }) => { seenAppend = o.appendSystemPrompt; return undefined; };

    const svc = new BrainService(d as never);
    await svc.start(1);
    const opts = (d.createSession as unknown as { mock: { calls: [{ customTools: { name: string }[] }][] } }).mock.calls[0][0];
    expect(opts.customTools.map((t) => t.name)).toContain('demo_echo');
    expect(opts.customTools.map((t) => t.name)).toContain('orca_list_tasks');
    expect(seenAppend).toContain('Follow house style.');
  });

  it('applies a per-user model override', async () => {
    const d = fakeDeps();
    (d as unknown as { userSettings: () => { model: string; modelProvider: string; autoCompact: boolean } }).userSettings =
      () => ({ model: 'ollama/kimi-k2.7-code', modelProvider: 'relay', autoCompact: false });
    const svc = new BrainService(d as never);
    await svc.start(1);
    expect(svc.status(1).model).toBe('ollama/kimi-k2.7-code');
  });

  it('send forwards to the PI session, persists the turn, and emits events', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    const seen: { type: string }[] = [];
    svc.subscribe(1, (e) => seen.push(e));
    await svc.send(1, 'hi');
    expect(d.session.prompt).toHaveBeenCalledWith('hi');
    expect(seen.some((e) => e.type === 'idle')).toBe(true);
    const roles = d.store.getMessages('brain-1').map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('history extracts display text from stored string and array content', () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    d.store.createSession({ id: 'brain-1', userId: 1, model: 'm' });
    d.store.appendMessage({ id: 'a', sessionId: 'brain-1', parentId: null, role: 'user', content: { role: 'user', content: 'ahoj' } });
    d.store.appendMessage({ id: 'b', sessionId: 'brain-1', parentId: null, role: 'assistant', content: { role: 'assistant', content: [{ type: 'text', text: 'čau' }] } });
    expect(svc.history(1)).toEqual([{ role: 'user', text: 'ahoj' }, { role: 'assistant', text: 'čau' }]);
  });

  it('channelSend opens a channel session, applies its policy, and returns the reply', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    const policy = { allowedProjectIds: new Set([1]), allowedPaths: () => ['/repo/a'] };
    const reply = await svc.channelSend({ channelId: 'disc-42', ownerUserId: 1, policy, promptAppend: ['Role: dev tým.'] }, 'ahoj');
    expect(d.session.prompt).toHaveBeenCalledWith('ahoj');
    expect(reply).toBe('echo:ahoj');
    // Channel history persisted under its own session id, separate from the user session.
    const roles = d.store.getMessages('brain-ch-disc-42').map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('startPlatforms wires an adapter: mapped sender gets a reply, unmapped stays silent', async () => {
    const d = fakeDeps();
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('discord', {}, { info() {}, warn() {}, error() {} });
    let handler: ((src: unknown, text: string) => Promise<string | undefined>) | null = null;
    let connected = false;
    ctx.registerPlatform({
      name: 'fake',
      connect: async () => { connected = true; },
      listen: (h) => { handler = h; },
      send: async () => {},
    });
    (d as unknown as { plugins: PluginRegistry }).plugins = reg;
    (d as unknown as { platformOwner: () => number }).platformOwner = () => 1;
    (d as unknown as { policyForProjects: (ids: number[]) => unknown }).policyForProjects =
      (ids) => ({ allowedProjectIds: new Set(ids), allowedPaths: () => ['/repo/x'] });

    const svc = new BrainService(d as never);
    await svc.startPlatforms();
    expect(connected).toBe(true);

    const mapped = await handler!({ platform: 'fake', userId: 'u1', roleIds: ['r'], channelId: 'c1', access: { projectIds: [1], prompt: 'Role dev.' } }, 'hello');
    expect(mapped).toBe('echo:hello');
    const unmapped = await handler!({ platform: 'fake', userId: 'u2', roleIds: [], channelId: 'c1' }, 'hi');
    expect(unmapped).toBeUndefined();
  });

  it('stop disposes the session and reports not running', async () => {
    const d = fakeDeps();
    const svc = new BrainService(d as never);
    await svc.start(1);
    svc.stop(1);
    expect(d.session.dispose).toHaveBeenCalled();
    expect(svc.status(1).running).toBe(false);
  });
});
