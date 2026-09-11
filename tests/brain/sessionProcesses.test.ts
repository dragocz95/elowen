import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { SessionProcessService } from '../../src/brain/service/sessionProcesses.js';
import { processRegistry, type ProcessHandle } from '../../src/brain/processRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import type { ProcessInfo } from '../../src/brain/processRegistry.js';

const OWNER = 1;
const FOREIGN = 2;
const PARENT = 'brain-1';
const MY_CHILD = 'brain-ch-subagent-sub-dlg-mine';
const OTHER_CHILD = 'brain-ch-subagent-sub-dlg-other';

function remoteProcess(over: Partial<ProcessInfo>): ProcessInfo {
  return {
    id: 'remote-1', command: 'npm run build', cwd: '/w', startedAt: '2026-09-11T10:00:00Z',
    sessionId: MY_CHILD, running: true, exitCode: null, completionMode: 'job',
    ...over,
  };
}

function harness(opts: { remote?: ProcessInfo[]; streams?: { sessionId: string; owner: boolean }[] } = {}) {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  store.createSession({ id: PARENT, userId: OWNER, model: 'm' });
  // The foreign child stands alone: the store refuses a cross-user parent link, and ownership reads only
  // the child row's user_id anyway.
  store.createSession({ id: MY_CHILD, userId: OWNER, model: 'm', parentSessionId: PARENT });
  store.createSession({ id: OTHER_CHILD, userId: FOREIGN, model: 'm' });
  const attachments = new ClientAttachments();
  const received: unknown[] = [];
  for (const stream of opts.streams ?? []) {
    const listener = (event: unknown): void => { received.push(event); };
    attachments.clientStreams.set(listener, stream.sessionId);
  }
  const service = new SessionProcessService({
    store,
    attachments,
    // The instance operator is account 1; account 2 is a colleague in a shared room.
    identity: { isOwner: (userId: number | undefined) => userId === OWNER } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
    ...(opts.remote ? {
      remoteProcesses: () => Promise.resolve(opts.remote!),
      remoteProcessOutput: (id: string) => Promise.resolve(opts.remote!.some((p) => p.id === id) ? `out:${id}` : null),
      killRemoteProcess: (id: string) => Promise.resolve(opts.remote!.some((p) => p.id === id)),
    } : {}),
  });
  return { service, received, store };
}

function localHandle(id: string, sessionId: string, accountUserId: number | null): ProcessHandle {
  return {
    id, command: `cmd ${id}`, cwd: '/w', startedAt: '2026-09-11T10:00:00Z',
    accountUserId, sessionId,
    completionMode: 'job',
    running: () => true,
    exitCode: () => null,
    readAll: () => `local:${id}`,
    kill: () => {},
  };
}

describe('the process panel spans both registries under one ownership rule', () => {
  it('merges runner-hosted sub-agent processes into the owner-wide list', async () => {
    const { service } = harness({ remote: [remoteProcess({}), remoteProcess({ id: 'fg', completionMode: 'foreground' })] });
    processRegistry.register(localHandle('local-1', PARENT, OWNER));
    try {
      const list = await service.processes(OWNER);
      expect(list.map((p) => p.id).sort()).toEqual(['local-1', 'remote-1']);
      // A foreground handle of a runner child is transient turn work, exactly like a local one: never listed.
      expect(list.find((p) => p.id === 'fg')).toBeUndefined();
    } finally { await processRegistry.kill('local-1'); }
  });

  it('keeps a runner child of ANOTHER account out of the owner-wide list', async () => {
    const { service } = harness({ remote: [remoteProcess({ sessionId: OTHER_CHILD })] });
    const list = await service.processes(OWNER);
    expect(list.map((p) => p.id)).toEqual([]);
  });

  it('scopes the session view to one conversation across both registries', async () => {
    const { service } = harness({
      remote: [remoteProcess({}), remoteProcess({ id: 'remote-other', sessionId: OTHER_CHILD })],
    });
    processRegistry.register(localHandle('local-child', MY_CHILD, null));
    try {
      const mine = await service.processes(OWNER, MY_CHILD);
      expect(mine.map((p) => p.id).sort()).toEqual(['local-child', 'remote-1']);
      // The CLI's bound-session contract: a foreign session is refused outright (→ 404 upstream).
      await expect(service.processes(OWNER, OTHER_CHILD)).rejects.toThrow('unknown session');
    } finally { await processRegistry.kill('local-child'); }
  });

  it('refuses to kill a runner process the child\'s turn is still awaiting (foreground guard)', async () => {
    // The session-scoped list deliberately still shows a foreground handle (Ctrl+B reads it), but the
    // process API must never SIGKILL a command a live turn is blocked on — locally or across the runner.
    const { service } = harness({ remote: [remoteProcess({ id: 'fg-remote', completionMode: 'foreground' })] });
    expect(await service.processes(OWNER, MY_CHILD).then((list) => list.map((p) => p.id))).toEqual(['fg-remote']);
    expect(await service.killProcess(OWNER, 'fg-remote')).toBe(false);
    expect(await service.killProcess(OWNER, 'fg-remote', MY_CHILD)).toBe(false);
  });

  it('authorizes runner output and kill against the same snapshot before forwarding', async () => {
    const { service } = harness({ remote: [remoteProcess({})] });
    expect(await service.processOutput(OWNER, 'remote-1')).toBe('out:remote-1');
    expect(await service.killProcess(OWNER, 'remote-1')).toBe(true);
    // A process the runner does not hold, or one of another account's children, is invisible end to end.
    expect(await service.processOutput(OWNER, 'remote-nope')).toBeNull();
    expect(await service.killProcess(OWNER, 'remote-nope')).toBe(false);
    expect(await service.processOutput(FOREIGN, 'remote-1')).toBeNull();
    expect(await service.killProcess(FOREIGN, 'remote-1')).toBe(false);
  });

  it('still kills through the LOCAL registry without touching the remote path', async () => {
    let remoteKillAsked = 0;
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: PARENT, userId: OWNER, model: 'm' });
    const attachments = new ClientAttachments();
    const service = new SessionProcessService({
      store, attachments,
      identity: { isOwner: () => true } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
      remoteProcesses: () => Promise.resolve([]),
      killRemoteProcess: () => { remoteKillAsked += 1; return Promise.resolve(true); },
    });
    const handle = localHandle('local-1', PARENT, OWNER);
    processRegistry.register(handle);
    try {
      expect(await service.killProcess(OWNER, 'local-1')).toBe(true);
      expect(processRegistry.get('local-1')).toBeUndefined();
      expect(remoteKillAsked).toBe(0);
    } finally { processRegistry.remove('local-1'); }
  });
});

describe('live process snapshots reach the owner streams of a delegated child', () => {
  it('resolves a null handle account from the child session row', () => {
    const { service, received } = harness({
      streams: [{ sessionId: MY_CHILD, owner: true }, { sessionId: OTHER_CHILD, owner: false }],
    });
    // The change listener passes the handle account verbatim — null for a delegated child's process.
    const processes = [remoteProcess({})];
    service.broadcastProcesses(MY_CHILD, null, processes);
    expect(received).toEqual([{ type: 'process', processes }]);
    // ...and to no stream when the session owner is not an operator of this instance.
    service.broadcastProcesses(OTHER_CHILD, null, [remoteProcess({ sessionId: OTHER_CHILD })]);
    expect(received).toHaveLength(1);
  });

  it('delivers the snapshot only to streams attached to that session and owned by an operator', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: PARENT, userId: OWNER, model: 'm' });
    store.createSession({ id: MY_CHILD, userId: OWNER, model: 'm', parentSessionId: PARENT });
    const attachments = new ClientAttachments();
    const childReceived: unknown[] = [];
    const parentReceived: unknown[] = [];
    const childListener = (event: unknown): void => { childReceived.push(event); };
    const parentListener = (event: unknown): void => { parentReceived.push(event); };
    attachments.clientStreams.set(childListener, MY_CHILD);
    attachments.clientStreams.set(parentListener, PARENT);
    const service = new SessionProcessService({
      store, attachments,
      identity: { isOwner: () => true } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
    });
    const processes = [remoteProcess({})];
    service.broadcastProcesses(MY_CHILD, null, processes);
    expect(childReceived).toEqual([{ type: 'process', processes }]);
    // The parent's stream is attached to a DIFFERENT conversation: it polls its own list instead.
    expect(parentReceived).toEqual([]);
  });

  it('delivers nothing for a session whose owner is not an operator', () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: OTHER_CHILD, userId: FOREIGN, model: 'm' });
    const attachments = new ClientAttachments();
    const received: unknown[] = [];
    attachments.clientStreams.set((event) => { received.push(event); }, OTHER_CHILD);
    const service = new SessionProcessService({
      store, attachments,
      identity: { isOwner: (userId) => userId === OWNER } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
    });
    service.broadcastProcesses(OTHER_CHILD, null, [remoteProcess({ sessionId: OTHER_CHILD })]);
    expect(received).toEqual([]);
  });

  it('an UNAVAILABLE runner rejects the list instead of answering a false empty', async () => {
    // A healthy runner answering empty stays an honest empty; the wedged service below is built
    // directly so its remote half rejects, like a wedged runner's strict RPC.
    const { service } = harness({ remote: [] });
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: MY_CHILD, userId: OWNER, model: 'm' });
    const attachments = new ClientAttachments();
    const wedged = new SessionProcessService({
      store, attachments,
      identity: { isOwner: (userId) => userId === OWNER } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
      remoteProcesses: () => Promise.reject(new Error('the sub-agent runner did not answer the process request in time')),
    });
    await expect(wedged.processes(OWNER)).rejects.toThrow('process list unavailable');
    // The same read against a HEALTHY empty runner stays an honest empty (the two are different answers).
    await expect(service.processes(OWNER)).resolves.toEqual([]);
  });

  it('an unconfirmed remote kill rejects instead of reporting a stop that never landed', async () => {
    const db = openDb(':memory:');
    const store = new BrainStore(db);
    store.createSession({ id: MY_CHILD, userId: OWNER, model: 'm' });
    const attachments = new ClientAttachments();
    const wedged = new SessionProcessService({
      store, attachments,
      identity: { isOwner: (userId) => userId === OWNER } as ConstructorParameters<typeof SessionProcessService>[0]['identity'],
      remoteProcesses: () => Promise.resolve([remoteProcess({ id: 'bg-wedge', sessionId: MY_CHILD })]),
      killRemoteProcess: () => Promise.reject(new Error('the sub-agent runner did not answer the process request in time')),
    });
    await expect(wedged.killProcess(OWNER, 'bg-wedge')).rejects.toThrow('did not answer the process request in time');
  });
});
