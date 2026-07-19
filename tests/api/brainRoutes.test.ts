import { describe, it, expect, vi } from 'vitest';
import type { BrainCredentialAccess } from '../../src/brain/providerUsage.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { Readiness } from '../../src/store/readiness.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';
import type { TurnRequest } from '../../src/brain/service/turnRequest.js';
import type { BrainEvent } from '../../src/brain/events.js';
import type { ProcessInfo } from '../../src/brain/processRegistry.js';

const proc = (id: string, sessionId: string | null): ProcessInfo => ({
  id, command: `sleep ${id}`, cwd: '/w', startedAt: '2026-01-01T00:00:00Z', sessionId, running: true, exitCode: null,
});

function fakeBrain() {
  const started = new Set<number>();
  const sends: { id: number; text: string; mode?: string }[] = [];
  const boundSendCalls: { session?: string; client?: { id: string; generation: number } }[] = [];
  const fastCalls: { id: number; on?: boolean; session?: string }[] = [];
  const stopSessionCalls: { id: number; session?: string; client?: string; generation?: number }[] = [];
  const interruptQueuedCalls: { id: number; session?: string; client?: { id: string; generation: number } }[] = [];
  const detachSubagentCalls: { id: number; session?: string; client?: { id: string; generation: number } }[] = [];
  const detachCommandCalls: { id: number; session?: string; client?: { id: string; generation: number } }[] = [];
  const startCalls: { id: number; opts?: { fresh?: boolean; clientId?: string; clientGeneration?: number } }[] = [];
  const tapSnapshotCalls: { id: number; session: string }[] = [];
  const subagentSends: { id: number; session: string; text: string }[] = [];
  const acceptedSendFailures: { session: string; message: string }[] = [];
  const turnRequests: Omit<TurnRequest, 'onAdmitted'>[] = [];
  const bindContextCalls: { id: number; channel: string; session: string }[] = [];
  let bindContextError: Error | null = null;
  let subagentPreflightError: Error | null = null;
  let sendBeforeAdmissionError: Error | null = null;
  let sendAfterAdmissionError: Error | null = null;
  let blockSends = false;
  // Background-process surfaces: the service scopes by ownership (never 404s without a session) and throws
  // only for an explicit unknown/foreign `?session=`.
  const processCalls: { id: number; session?: string }[] = [];
  const processOutputCalls: { id: number; processId: string; session?: string }[] = [];
  const killProcessCalls: { id: number; processId: string; session?: string }[] = [];
  let owner = true;
  let activeProvider = ''; // the pi provider of the active model — drives usage-rail selection
  let processes: ProcessInfo[] = [];
  let processOutputText: string | null = 'buffer';
  let unknownSessionError: Error | null = null;
  let snapshotPending: BrainEvent[] = [{ type: 'text', delta: 'post-snapshot event' }];
  let snapshotPendingSync = false;
  let snapshotOffCalls = 0;
  const queues = new Map<number, { id: string; text: string }[]>();
  const send = async (request: TurnRequest) => {
    const { userId: id, text, mode, session, client, onAdmitted } = request;
    if (!started.has(id)) throw new Error('brain not started for user');
    if (sendBeforeAdmissionError) throw sendBeforeAdmissionError;
    sends.push({ id, text, mode });
    boundSendCalls.push({ session, client });
    const { onAdmitted: _onAdmitted, ...recorded } = request;
    turnRequests.push(recorded);
    onAdmitted?.(session ?? `brain-${id}`);
    if (sendAfterAdmissionError) throw sendAfterAdmissionError;
    if (blockSends) await new Promise(() => {});
  };
  return {
    sends,
    boundSendCalls,
    fastCalls,
    stopSessionCalls,
    interruptQueuedCalls,
    detachSubagentCalls,
    detachCommandCalls,
    startCalls,
    tapSnapshotCalls,
    subagentSends,
    acceptedSendFailures,
    turnRequests,
    get snapshotOffCalls() { return snapshotOffCalls; },
    __setSnapshotPending: (events: BrainEvent[], synchronous = false) => {
      snapshotPending = events;
      snapshotPendingSync = synchronous;
    },
    __failSubagentPreflight: (message: string | null) => { subagentPreflightError = message ? new Error(message) : null; },
    __failSendBeforeAdmission: (message: string | null) => { sendBeforeAdmissionError = message ? new Error(message) : null; },
    __failSendAfterAdmission: (message: string | null) => { sendAfterAdmissionError = message ? new Error(message) : null; },
    __blockSends: () => { blockSends = true; },
    processCalls,
    processOutputCalls,
    killProcessCalls,
    __setOwner: (on: boolean) => { owner = on; },
    __setProcesses: (list: ProcessInfo[]) => { processes = list; },
    __setProcessOutput: (text: string | null) => { processOutputText = text; },
    __failUnknownSession: () => { unknownSessionError = new Error('unknown session'); },
    isOwner: (_id: number) => owner,
    processes: (id: number, session?: string) => {
      processCalls.push({ id, session });
      if (unknownSessionError) throw unknownSessionError;
      return processes;
    },
    processOutput: (id: number, processId: string, session?: string) => {
      processOutputCalls.push({ id, processId, session });
      if (unknownSessionError) throw unknownSessionError;
      return processOutputText;
    },
    killProcess: (id: number, processId: string, session?: string) => {
      killProcessCalls.push({ id, processId, session });
      if (unknownSessionError) throw unknownSessionError;
      return true;
    },
    /** Test helper: seed a user's pending mid-turn queue. */
    __enqueue: (id: number, item: { id: string; text: string }) => { queues.set(id, [...(queues.get(id) ?? []), item]); },
    __setProvider: (p: string) => { activeProvider = p; },
    status: (id: number) => ({ running: started.has(id), sessionId: started.has(id) ? `brain-${id}` : null, model: 'm', provider: activeProvider, queued: queues.get(id) ?? [], fast: false, fastAvailable: true }),
    start: async (id: number, opts?: { fresh?: boolean; clientId?: string; clientGeneration?: number }) => {
      startCalls.push({ id, opts });
      started.add(id);
      return { sessionId: `brain-${id}` };
    },
    preflightSend: (id: number) => { if (!started.has(id)) throw new Error('brain not started for user'); },
    send,
    startSend: (request: TurnRequest) => {
      let resolveAdmitted!: (sessionId: string) => void;
      let rejectAdmitted!: (error: unknown) => void;
      let settled = false;
      const admitted = new Promise<string>((resolve, reject) => { resolveAdmitted = resolve; rejectAdmitted = reject; });
      const completed = send({
        ...request,
        onAdmitted: (sessionId) => {
          settled = true;
          resolveAdmitted(sessionId);
        },
      }).then(
        () => { if (!settled) rejectAdmitted(new Error('turn completed before admission')); },
        (error) => { if (!settled) rejectAdmitted(error); throw error; },
      );
      return { admitted, completed };
    },
    publishAcceptedSendFailure: (session: string, error: unknown) => {
      acceptedSendFailures.push({ session, message: error instanceof Error ? error.message : String(error) });
      return true;
    },
    queueList: (id: number) => queues.get(id) ?? [],
    queueRemove: (id: number, qid: string) => {
      const list = queues.get(id) ?? [];
      queues.set(id, list.filter((q) => q.id !== qid));
      return (queues.get(id)!.length) < list.length;
    },
    subscribe: () => () => {},
    tapSession: () => () => {},
    tapSessionSnapshot: (id: number, session: string, listener: (event: BrainEvent) => void) => {
      tapSnapshotCalls.push({ id, session });
      // Arrives after the atomic snapshot was captured but while its first SSE frame is flushing.
      const publishPending = () => { for (const event of snapshotPending) listener(event); };
      if (snapshotPendingSync) publishPending();
      else queueMicrotask(publishPending);
      return {
        off: () => { snapshotOffCalls += 1; },
        snapshot: {
          type: 'snapshot' as const,
          cursor: 7,
          history: [{ role: 'user', text: 'stored child turn' }],
          events: [{ type: 'text' as const, delta: 'running child output' }],
        },
      };
    },
    /** Writes a real temp file so the route can stream it back; a 'missing' id throws (→ 404). Records
     *  each cleaned-up path so the test can assert the route removed the temp file afterwards. */
    cleaned: [] as string[],
    exportSession(_id: number, sessionId: string, format: 'html' | 'jsonl') {
      if (sessionId === 'missing') return Promise.reject(new Error('unknown session'));
      const dir = mkdtempSync(join(tmpdir(), 'test-export-'));
      const filename = `elowen-${sessionId}.${format}`;
      const path = join(dir, filename);
      writeFileSync(path, format === 'html' ? '<!DOCTYPE html><html>hi</html>' : '{"type":"session"}\n');
      return Promise.resolve({
        path, filename,
        contentType: format === 'html' ? 'text/html; charset=utf-8' : 'application/x-ndjson',
        cleanup: () => { this.cleaned.push(path); rmSync(dir, { recursive: true, force: true }); },
      });
    },
    stop: (id: number) => { started.delete(id); },
    setFast: (id: number, on?: boolean, session?: string) => {
      fastCalls.push({ id, on, session });
      return { fast: on ?? true, fastAvailable: true };
    },
    stopSession: async (id: number, session?: string, client?: string, generation?: number) => {
      stopSessionCalls.push({ id, session, client, generation });
      return { stopped: true, disposed: true };
    },
    interruptQueued: async (id: number, session?: string, client?: { id: string; generation: number }) => {
      interruptQueuedCalls.push({ id, session, client });
      return { interrupted: true, injected: true };
    },
    detachForegroundSubagents: async (id: number, session?: string, client?: { id: string; generation: number }) => {
      detachSubagentCalls.push({ id, session, client });
      return { detached: 2 };
    },
    detachForegroundCommands: async (id: number, session?: string, client?: { id: string; generation: number }) => {
      detachCommandCalls.push({ id, session, client });
      return { detached: 1 };
    },
    history: (_id: number) => [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    messagesOf: () => [],
    preflightSubagentSend: () => { if (subagentPreflightError) throw subagentPreflightError; },
    sendToSubagent: async (id: number, session: string, text: string) => { subagentSends.push({ id, session, text }); },
    searchMessages: (id: number, q: string) =>
      q.trim().length < 2 ? [] : [{ sessionId: `s-${id}`, sessionTitle: 'T', role: 'user', snippet: q, ts: '2026-01-01 00:00:00' }],
    bindContextCalls,
    __failBindContext: (message: string | null) => { bindContextError = message ? new Error(message) : null; },
    // Two conversations, so a limit=1 window has a real second page (hasMore).
    listSessions: (id: number, opts?: { limit?: number; offset?: number }) => {
      const all = [
        { id: `brain-${id}`, title: 'A', model: 'm', updated_at: '', running: false, active: true, attached: 0 },
        { id: `brain-${id}-x`, title: 'B', model: 'm', updated_at: '', running: false, active: false, attached: 0 },
      ];
      if (!opts) return all;
      const offset = opts.offset ?? 0;
      const items = opts.limit === undefined ? all.slice(offset) : all.slice(offset, offset + opts.limit);
      return { items, total: all.length, hasMore: offset + items.length < all.length };
    },
    bindChannelContext: async (id: number, channel: string, session: string) => {
      bindContextCalls.push({ id, channel, session });
      if (bindContextError) throw bindContextError;
      return { title: `title-of-${session}` };
    },
  };
}

function setup(opts: { brainAuth?: BrainCredentialAccess } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const brain = fakeBrain();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    brain: brain as never, brainAuth: opts.brainAuth,
  });
  return { app, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id), agentTok: users.issueToken(amy.id, 'agent'), brain };
}
const auth = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const post = (t: string, body: unknown) => ({ method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (t: string) => ({ method: 'DELETE', headers: { authorization: `Bearer ${t}` } });

describe('brain routes', () => {
  it('status → start → send happy path', async () => {
    const { app, amyTok } = setup();
    expect((await (await app.request('/brain/status', auth(amyTok))).json() as { running: boolean }).running).toBe(false);
    const start = await app.request('/brain/start', post(amyTok, {}));
    expect(start.status).toBe(201);
    expect((await start.json() as { sessionId: string }).sessionId).toBe('brain-2');
    expect((await (await app.request('/brain/status', auth(amyTok))).json() as { running: boolean }).running).toBe(true);
    expect((await app.request('/brain/send', post(amyTok, { text: 'hi' }))).status).toBe(202);
  });

  it('acknowledges an accepted send before the model turn settles', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    brain.__blockSends();
    const response = await app.request('/brain/send', post(amyTok, { text: 'long diagnostics turn' }));
    expect(response.status).toBe(202);
    expect(brain.sends.at(-1)?.text).toBe('long diagnostics turn');
  });

  it('does not acknowledge a send that fails before durable admission', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    brain.__failSendBeforeAdmission('provider setup failed');
    const response = await app.request('/brain/send', post(amyTok, { text: 'keep this prompt' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'provider setup failed' });
  });

  it('publishes a visible stream error when an admitted turn later fails', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    brain.__failSendAfterAdmission('model turn failed');
    const response = await app.request('/brain/send', post(amyTok, { text: 'accepted prompt' }));
    expect(response.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(brain.acceptedSendFailures).toEqual([{ session: 'brain-2', message: 'model turn failed' }]);
  });

  it('passes the authenticated stable client identity through start', async () => {
    const { app, amyTok, brain } = setup();
    const start = await app.request('/brain/start', post(amyTok, { fresh: true, client: 'cli-a', generation: 7 }));
    expect(start.status).toBe(201);
    expect(brain.startCalls.at(-1)).toEqual({ id: 2, opts: {
      provider: undefined, session: undefined, fresh: true, cwd: undefined, clientId: 'cli-a', clientGeneration: 7,
    } });
  });

  it('passes plan mode through /brain/send', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    expect((await app.request('/brain/send', post(amyTok, { text: 'outline', mode: 'plan' }))).status).toBe(202);
    expect(brain.sends.at(-1)).toEqual({ id: 2, text: 'outline', mode: 'plan' });
  });

  it('passes a bound client generation through /brain/send', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    const res = await app.request('/brain/send', post(amyTok, {
      text: 'late-safe', session: 'brain-2', client: 'cli-a', generation: 7,
    }));
    expect(res.status).toBe(202);
    expect(brain.boundSendCalls.at(-1)).toEqual({
      session: 'brain-2', client: { id: 'cli-a', generation: 7 },
    });
  });

  it('maps the unchanged REST send schema into one complete TurnRequest', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    const response = await app.request('/brain/send', post(amyTok, {
      text: 'expanded prompt',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
      mode: 'plan',
      cwd: '/o',
      session: 'brain-2',
      display: 'clean prompt',
      client: 'cli-a',
      generation: 7,
    }));

    expect(response.status).toBe(202);
    expect(brain.turnRequests.at(-1)).toEqual({
      userId: 2,
      text: 'expanded prompt',
      images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
      mode: 'plan',
      clientCwd: '/o',
      session: 'brain-2',
      display: 'clean prompt',
      client: { id: 'cli-a', generation: 7 },
    });
  });

  it('messages returns the display history', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/brain/messages', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }]);
  });

  it('preflights a delegated continuation so a legacy child is rejected instead of silently detached', async () => {
    const { app, amyTok, brain } = setup();
    brain.__failSubagentPreflight('delegated access unavailable');
    const rejected = await app.request('/brain/subagent/send', post(amyTok, { session: 'brain-ch-subagent-legacy', text: 'continue' }));
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: 'delegated access unavailable' });
    expect(brain.subagentSends).toEqual([]);

    brain.__failSubagentPreflight(null);
    const accepted = await app.request('/brain/subagent/send', post(amyTok, { session: 'brain-ch-subagent-good', text: 'continue' }));
    expect(accepted.status).toBe(200);
    await Promise.resolve(); // detached route continuation
    expect(brain.subagentSends).toEqual([{ id: 2, session: 'brain-ch-subagent-good', text: 'continue' }]);
  });

  it('opt-in fixed-session stream starts with one durable + live snapshot frame', async () => {
    const { app, amyTok, brain } = setup();
    const ac = new AbortController();
    const res = await app.request('/brain/stream?session=brain-ch-subagent-a&snapshot=1', {
      headers: { authorization: `Bearer ${amyTok}` }, signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = '';
    for (let i = 0; i < 6 && !body.includes('post-snapshot event'); i++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    ac.abort();
    await reader.cancel().catch(() => {});
    expect(brain.tapSnapshotCalls).toEqual([{ id: 2, session: 'brain-ch-subagent-a' }]);
    expect(body).toContain('event: snapshot');
    expect(body).toContain('id: 7');
    expect(body).toContain('stored child turn');
    expect(body).toContain('running child output');
    expect(body).toContain('post-snapshot event');
    expect(body.indexOf('running child output')).toBeLessThan(body.indexOf('post-snapshot event'));
  });

  it('unsubscribes and closes an opt-in snapshot stream when the raw pre-snapshot queue overflows', async () => {
    const { app, amyTok, brain } = setup();
    brain.__setSnapshotPending(Array.from({ length: 2_049 }, (_, index) => ({
      type: 'tool' as const, id: `overflow-${index}`, name: 'Read',
    })), true);
    const ac = new AbortController();
    const res = await app.request('/brain/stream?session=brain-ch-subagent-overflow&snapshot=1', {
      headers: { authorization: `Bearer ${amyTok}` }, signal: ac.signal,
    });
    expect(res.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(brain.snapshotOffCalls).toBe(1);
    const body = await res.text();
    expect(body).not.toContain('overflow-');
    expect(body.match(/overflow-/g) ?? []).toHaveLength(0);
    ac.abort();
  });

  it('unsubscribes a pre-snapshot stream when one serialized UTF-8 event exceeds four MiB', async () => {
    const { app, amyTok, brain } = setup();
    brain.__setSnapshotPending([{ type: 'text', delta: '🐉'.repeat(1_100_000) }], true);
    const ac = new AbortController();
    const res = await app.request('/brain/stream?session=brain-ch-subagent-byte-overflow&snapshot=1', {
      headers: { authorization: `Bearer ${amyTok}` }, signal: ac.signal,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(brain.snapshotOffCalls).toBe(1);
    await res.body?.cancel();
    ac.abort();
  });

  it('send before start returns 409', async () => {
    const { app, amyTok } = setup();
    expect((await app.request('/brain/send', post(amyTok, { text: 'hi' }))).status).toBe(409);
  });

  it('send requires the text field (400)', async () => {
    const { app, amyTok } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    expect((await app.request('/brain/send', post(amyTok, {}))).status).toBe(400);
  });

  it('an agent-scoped token cannot use brain routes', async () => {
    const { app, agentTok } = setup();
    expect((await app.request('/brain/status', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/start', post(agentTok, {}))).status).toBe(403);
    expect((await app.request('/brain/send', post(agentTok, { text: 'x' }))).status).toBe(403);
    expect((await app.request('/brain/messages', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/search?q=hi', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/queue', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/queue/x', del(agentTok))).status).toBe(403);
    expect((await app.request('/brain/rate-limits', auth(agentTok))).status).toBe(403);
    expect((await app.request('/brain/fast', post(agentTok, { on: true }))).status).toBe(403);
    expect((await app.request('/brain/session/stop', post(agentTok, {}))).status).toBe(403);
    expect((await app.request('/brain/interrupt-queued', post(agentTok, {}))).status).toBe(403);
    expect((await app.request('/brain/subagents/background', post(agentTok, {}))).status).toBe(403);
    expect((await app.request('/brain/commands/background', post(agentTok, {}))).status).toBe(403);
  });

  it('toggles Fast for the bound session through both action routes', async () => {
    const { app, amyTok, brain } = setup();
    const direct = await app.request('/brain/fast', post(amyTok, { on: true, session: 'brain-child' }));
    expect(direct.status).toBe(200);
    expect(await direct.json()).toEqual({ fast: true, fastAvailable: true });
    expect(brain.fastCalls.at(-1)).toEqual({ id: 2, on: true, session: 'brain-child' });

    const command = await app.request('/brain/command', post(amyTok, { name: 'fast', on: false, session: 'brain-child' }));
    expect(command.status).toBe(200);
    expect((await command.json() as { message: string }).message).toBe('Fast mode disabled.');
    expect(brain.fastCalls.at(-1)).toEqual({ id: 2, on: false, session: 'brain-child' });
  });

  it('stops a bound live session without deleting its persisted conversation', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/session/stop', post(amyTok, { session: 'brain-child', client: 'cli-a', generation: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true, disposed: true });
    expect(brain.stopSessionCalls).toEqual([{ id: 2, session: 'brain-child', client: 'cli-a', generation: 3 }]);
  });

  it('interrupts queued work with the bound CLI generation intact', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/interrupt-queued', post(amyTok, {
      session: 'brain-child', client: 'cli-a', generation: 3,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interrupted: true, injected: true });
    expect(brain.interruptQueuedCalls).toEqual([{
      id: 2, session: 'brain-child', client: { id: 'cli-a', generation: 3 },
    }]);
  });

  it('moves foreground sub-agents to background with the bound CLI generation intact', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/subagents/background', post(amyTok, {
      session: 'brain-child', client: 'cli-a', generation: 3,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ detached: 2 });
    expect(brain.detachSubagentCalls).toEqual([{
      id: 2, session: 'brain-child', client: { id: 'cli-a', generation: 3 },
    }]);
  });

  it('moves foreground commands to background with the bound CLI generation intact', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/commands/background', post(amyTok, {
      session: 'brain-child', client: 'cli-a', generation: 3,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ detached: 1 });
    expect(brain.detachCommandCalls).toEqual([{
      id: 2, session: 'brain-child', client: { id: 'cli-a', generation: 3 },
    }]);
  });

  it('publishes surface-specific Fast and rename commands from one catalog', async () => {
    const { app, amyTok } = setup();
    const cli = await (await app.request('/brain/commands?surface=cli', auth(amyTok))).json() as { commands: { name: string }[] };
    const whatsapp = await (await app.request('/brain/commands?surface=whatsapp', auth(amyTok))).json() as { commands: { name: string }[] };
    expect(cli.commands.map((c) => c.name)).toEqual(expect.arrayContaining(['fast', 'rename']));
    expect(whatsapp.commands.map((c) => c.name)).toContain('fast');
    expect(whatsapp.commands.map((c) => c.name)).not.toContain('rename');
  });

  it('returns no OAuth usage when no auth storage is configured', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/brain/rate-limits?session=brain-2', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('selects the usage service by the active model provider and returns its windows', async () => {
    const brainAuth: BrainCredentialAccess = {
      get: (p) => (p === 'openai-codex'
        ? { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acct-1' }
        : undefined),
      getApiKey: async (p) => (p === 'openai-codex' ? 'tok' : undefined),
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
        secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: 1_900_500_000 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { app, amyTok, brain } = setup({ brainAuth });
      await app.request('/brain/start', post(amyTok, {}));

      // Active model is Codex OAuth → its usage service is selected and its windows come back.
      brain.__setProvider('openai-codex');
      const res = await app.request('/brain/rate-limits?session=brain-2', auth(amyTok));
      expect(res.status).toBe(200);
      const body = await res.json() as { provider: string; windows: { usedPercent: number; windowMinutes: number }[] };
      expect(body.provider).toBe('openai-codex');
      expect(body.windows).toEqual([
        { usedPercent: 30, windowMinutes: 300, resetsAt: 1_900_000_000 },
        { usedPercent: 70, windowMinutes: 10_080, resetsAt: 1_900_500_000 },
      ]);
      expect(fetchSpy).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.anything());

      // A provider with no registered usage service (e.g. a non-OAuth model) → null, no fetch.
      brain.__setProvider('some-byok-provider');
      expect(await (await app.request('/brain/rate-limits?session=brain-2', auth(amyTok))).json()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET /brain/rate-limits/all returns every connected account keyed by provider, ignoring the active model', async () => {
    const brainAuth: BrainCredentialAccess = {
      get: (p) => (p === 'openai-codex'
        ? { type: 'oauth', access: 'tok', refresh: 'r', expires: Date.now() + 3_600_000, accountId: 'acct-1' }
        : undefined),
      getApiKey: async (p) => (p === 'openai-codex' ? 'tok' : undefined),
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      plan_type: 'pro',
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18_000, reset_at: 1_900_000_000 },
        secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: 1_900_500_000 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const { app, amyTok, agentTok } = setup({ brainAuth });
      // Agent-scoped tokens are refused, like the single-provider route.
      expect((await app.request('/brain/rate-limits/all', auth(agentTok))).status).toBe(403);

      const res = await app.request('/brain/rate-limits/all', auth(amyTok));
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, { provider: string; windows: unknown[] }>;
      // Only the connected account (Codex) appears; Kimi has no credential and is omitted.
      expect(Object.keys(body)).toEqual(['openai-codex']);
      expect(body['openai-codex']!.provider).toBe('openai-codex');
      expect(body['openai-codex']!.windows).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('GET /brain/rate-limits/all is an empty map when no auth storage is configured', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/brain/rate-limits/all', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('GET /brain/queue lists the caller\'s pending queue; DELETE removes one (unknown id → removed:false)', async () => {
    const { app, amyTok, brain } = setup();
    await app.request('/brain/start', post(amyTok, {}));
    brain.__enqueue(2, { id: 'q1', text: 'first' });
    brain.__enqueue(2, { id: 'q2', text: 'second' });
    expect(await (await app.request('/brain/queue', auth(amyTok))).json())
      .toEqual([{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }]);
    const removed = await app.request('/brain/queue/q1', del(amyTok));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(await (await app.request('/brain/queue', auth(amyTok))).json()).toEqual([{ id: 'q2', text: 'second' }]);
    // An unknown id is a tolerated no-op, still 200.
    expect(await (await app.request('/brain/queue/nope', del(amyTok))).json()).toEqual({ removed: false });
    // The queue also seeds via status().queued for a booting client.
    expect((await (await app.request('/brain/status', auth(amyTok))).json() as { queued: unknown }).queued)
      .toEqual([{ id: 'q2', text: 'second' }]);
  });

  it('GET /brain/sessions/:id/export streams HTML by default and JSONL on request, then cleans up', async () => {
    const { app, amyTok, brain } = setup();
    const html = await app.request('/brain/sessions/s-2/export', auth(amyTok));
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('content-disposition')).toBe('attachment; filename="elowen-s-2.html"');
    expect(await html.text()).toContain('<!DOCTYPE html>');

    const jsonl = await app.request('/brain/sessions/s-2/export?format=jsonl', auth(amyTok));
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get('content-type')).toBe('application/x-ndjson');
    expect(jsonl.headers.get('content-disposition')).toBe('attachment; filename="elowen-s-2.jsonl"');

    // The route removes each temp file after streaming it out.
    expect(brain.cleaned).toHaveLength(2);
  });

  it('export 404s an unknown/foreign session and 403s an agent token', async () => {
    const { app, amyTok, agentTok } = setup();
    expect((await app.request('/brain/sessions/missing/export', auth(amyTok))).status).toBe(404);
    expect((await app.request('/brain/sessions/s-2/export', auth(agentTok))).status).toBe(403);
  });

  it('search scopes to the caller and passes q through; short q yields []', async () => {
    const { app, amyTok } = setup();
    const hits = await (await app.request('/brain/search?q=daemon', auth(amyTok))).json() as { sessionId: string; snippet: string }[];
    expect(hits).toEqual([{ sessionId: 's-2', sessionTitle: 'T', role: 'user', snippet: 'daemon', ts: '2026-01-01 00:00:00' }]);
    expect(await (await app.request('/brain/search?q=d', auth(amyTok))).json()).toEqual([]);
    expect(await (await app.request('/brain/search', auth(amyTok))).json()).toEqual([]);
  });

  it('GET /brain/sessions returns a bare array by default and a paged window with ?limit&offset', async () => {
    const { app, amyTok } = setup();
    // Back-compat: no paging params → the historical bare array every current caller consumes.
    const bare = await (await app.request('/brain/sessions', auth(amyTok))).json();
    expect(Array.isArray(bare)).toBe(true);
    expect(bare).toHaveLength(2);
    // Opt-in: a { items, total, hasMore } window.
    const page = await (await app.request('/brain/sessions?limit=1&offset=0', auth(amyTok))).json() as { items: unknown[]; total: number; hasMore: boolean };
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('POST /brain/context binds the admin\'s chosen conversation into the channel and returns its title', async () => {
    const { app, adminTok, brain } = setup();
    const res = await app.request('/brain/context', post(adminTok, { channel: 'discord-123', session: 'brain-1-x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ title: 'title-of-brain-1-x' });
    expect(brain.bindContextCalls).toHaveLength(1);
    expect(brain.bindContextCalls[0]).toMatchObject({ channel: 'discord-123', session: 'brain-1-x' });
  });

  it('POST /brain/context is admin-gated (shared channel state) and validates its body', async () => {
    const { app, adminTok, amyTok, agentTok } = setup();
    // Binding mutates SHARED channel state on a caller-supplied target, so unlike /brain/model it is
    // admin-only: an agent token and a plain non-admin user are both rejected before any binding.
    expect((await app.request('/brain/context', post(agentTok, { channel: 'discord-1', session: 'brain-1-x' }))).status).toBe(403);
    expect((await app.request('/brain/context', post(amyTok, { channel: 'discord-1', session: 'brain-1-x' }))).status).toBe(403);
    expect((await app.request('/brain/context', post(adminTok, { session: 'brain-1-x' }))).status).toBe(400);
    expect((await app.request('/brain/context', post(adminTok, { channel: 'discord-1' }))).status).toBe(400);
    expect((await app.request('/brain/context', post(adminTok, { channel: 5, session: 'x' }))).status).toBe(400);
  });

  it('POST /brain/context surfaces a guard rejection as 409', async () => {
    const { app, adminTok, brain } = setup();
    brain.__failBindContext('this conversation cannot be bound to a channel');
    const res = await app.request('/brain/context', post(adminTok, { channel: 'discord-1', session: 'brain-1' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'this conversation cannot be bound to a channel' });
  });
});

describe('GET /brain/models allow-list', () => {
  function setupWithProviders() {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    config.update({ brain: { providers: [
      { id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x', models: ['kimi', 'glm'], apiKey: 'k' },
    ] } } as never);
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      brain: fakeBrain() as never,
    });
    return { app, db, users, config, adminTok: users.issueToken(admin.id), amy, amyTok: users.issueToken(amy.id) };
  }

  it('every item carries its elowen exec spec; admin sees everything', async () => {
    const { app, adminTok } = setupWithProviders();
    const models = await (await app.request('/brain/models', auth(adminTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['elowen:relay/kimi', 'elowen:relay/glm']);
  });

  it('a non-admin sees every configured brain model (not global-bounded), narrowed only by their personal list', async () => {
    const { app, users, amy, amyTok } = setupWithProviders();
    // Brain execs aren't bounded by allowedExecs (CLI-only) — an empty personal list = every configured
    // brain model. (The bug this guards against: a non-admin getting an EMPTY model picker.)
    let models = await (await app.request('/brain/models', auth(amyTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['elowen:relay/kimi', 'elowen:relay/glm']);
    // A personal whitelist narrows further.
    users.setAllowedExecs(amy.id, ['elowen:relay/glm']);
    models = await (await app.request('/brain/models', auth(amyTok))).json() as { exec: string }[];
    expect(models.map((m) => m.exec)).toEqual(['elowen:relay/glm']);
  });
});

describe('LSP status + toggle routes', () => {
  function setupLsp() {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
    const users = new UserStore(db);
    const admin = users.create('admin', 'pw');
    const amy = users.create('amy', 'pw');
    const config = new ConfigStore(db);
    const app = createServer({
      tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
      engine: null as never, spawn: null as never, tmux: null as never,
      project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
      clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
      brain: fakeBrain() as never,
    });
    return { app, config, adminTok: users.issueToken(admin.id), amyTok: users.issueToken(amy.id) };
  }

  it('GET /brain/lsp reports enabled/running plus per-server rows (readable by any chat user)', async () => {
    const { app, amyTok } = setupLsp();
    const res = await app.request('/brain/lsp', auth(amyTok));
    expect(res.status).toBe(200);
    const s = await res.json() as { enabled: boolean; running: boolean; servers: { command: string; label: string; installed: boolean; running: boolean }[] };
    expect(typeof s.enabled).toBe('boolean');
    expect(typeof s.running).toBe('boolean');
    expect(s.servers.length).toBeGreaterThan(0);
    expect(s.servers.find((x) => x.command === 'typescript-language-server')).toMatchObject({ label: 'TypeScript' });
  });

  it('per-server rows carry the install metadata for the ctrl+i flow', async () => {
    const { app, amyTok } = setupLsp();
    const s = await (await app.request('/brain/lsp', auth(amyTok))).json() as { servers: { command: string; installable: boolean; installHint: string }[] };
    expect(s.servers.find((x) => x.command === 'typescript-language-server')).toMatchObject({ installable: true, installHint: 'npm install -g typescript-language-server typescript' });
    expect(s.servers.find((x) => x.command === 'gopls')).toMatchObject({ installable: false, installHint: 'go install golang.org/x/tools/gopls@latest' });
  });

  it('POST /brain/lsp/install is admin-only and 404s an unknown server', async () => {
    const { app, adminTok, amyTok } = setupLsp();
    expect((await app.request('/brain/lsp/install', post(amyTok, { command: 'gopls' }))).status).toBe(403);
    expect((await app.request('/brain/lsp/install', post(adminTok, { command: 'not-a-server' }))).status).toBe(404);
  });

  it('POST /brain/lsp/uninstall mirrors the guards and refuses toolchain-shipped servers', async () => {
    const { app, adminTok, amyTok } = setupLsp();
    expect((await app.request('/brain/lsp/uninstall', post(amyTok, { command: 'gopls' }))).status).toBe(403);
    expect((await app.request('/brain/lsp/uninstall', post(adminTok, { command: 'not-a-server' }))).status).toBe(404);
    const toolchain = await app.request('/brain/lsp/uninstall', post(adminTok, { command: 'gopls' }));
    expect(toolchain.status).toBe(400);
    expect(((await toolchain.json()) as { error: string }).error).toContain('go install');
  });

  it('POST /brain/command lsp is admin-only, flips the live manager AND persists the flag', async () => {
    const { app, config, adminTok, amyTok } = setupLsp();
    expect((await app.request('/brain/command', post(amyTok, { name: 'lsp' }))).status).toBe(403);

    const before = (await (await app.request('/brain/lsp', auth(adminTok))).json() as { enabled: boolean }).enabled;
    const r = await app.request('/brain/command', post(adminTok, { name: 'lsp' }));
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; data: { enabled: boolean } };
    expect(body.data.enabled).toBe(!before);
    expect(config.get().lspEnabled).toBe(!before); // survives a daemon restart via bootstrap re-seed
    // …and the live status endpoint agrees with the persisted flag.
    expect((await (await app.request('/brain/lsp', auth(adminTok))).json() as { enabled: boolean }).enabled).toBe(!before);
    // Flip back — the manager is a daemon-wide singleton, don't leak state into other tests.
    await app.request('/brain/command', post(adminTok, { name: 'lsp' }));
  });
});

// The background-process surfaces the web panel uses. Sessionless requests span every process the caller
// OWNS (across conversations, channels and sub-agent children) and never 404 — an explicit `?session=`
// keeps the CLI's bound-session contract, where an unknown/foreign session is a 404.
describe('brain process routes', () => {
  it('GET /brain/processes without a session asks for the whole owned list and returns it', async () => {
    const { app, amyTok, brain } = setup();
    brain.__setProcesses([proc('1', 'brain-2'), proc('2', 'brain-ch-subagent-sub-dlg-9')]);
    const res = await app.request('/brain/processes', auth(amyTok));
    expect(res.status).toBe(200);
    expect((await res.json() as ProcessInfo[]).map((p) => p.id)).toEqual(['1', '2']);
    expect(brain.processCalls.at(-1)).toEqual({ id: 2, session: undefined });
  });

  // The route turns a service throw into a 404 (see the next test), so this pins the complement: an empty
  // owner-wide list is a plain 200 [] and the route never invents a 404 of its own. That the SERVICE no
  // longer throws for an owner with no active session (the actual #19 fix) is asserted against the real
  // BrainService + store in tests/brain/brainService.test.ts — a stub could only restate itself here.
  it('GET /brain/processes answers an empty owner-wide list with 200 [], not 404', async () => {
    const { app, amyTok } = setup();
    const res = await app.request('/brain/processes', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('an explicit unknown/foreign ?session= is a 404 on every process route', async () => {
    const { app, amyTok, brain } = setup();
    brain.__failUnknownSession();
    expect((await app.request('/brain/processes?session=brain-9', auth(amyTok))).status).toBe(404);
    expect((await app.request('/brain/processes/1/output?session=brain-9', auth(amyTok))).status).toBe(404);
    expect((await app.request('/brain/processes/1?session=brain-9', del(amyTok))).status).toBe(404);
    expect(brain.processCalls.at(-1)).toEqual({ id: 2, session: 'brain-9' });
  });

  it('GET /brain/processes/:id/output streams the buffer, 404 for an unknown process', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/processes/1/output', auth(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ output: 'buffer' });
    expect(brain.processOutputCalls.at(-1)).toEqual({ id: 2, processId: '1', session: undefined });
    brain.__setProcessOutput(null); // not owned / unknown id
    expect((await app.request('/brain/processes/1/output', auth(amyTok))).status).toBe(404);
  });

  it('DELETE /brain/processes/:id kills by ownership without a session', async () => {
    const { app, amyTok, brain } = setup();
    const res = await app.request('/brain/processes/p1', del(amyTok));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ killed: true });
    expect(brain.killProcessCalls.at(-1)).toEqual({ id: 2, processId: 'p1', session: undefined });
  });

  it('every process route is OWNER-only: an admin who is not the operator gets 403', async () => {
    const { app, amyTok, brain } = setup();
    brain.__setOwner(false);
    expect((await app.request('/brain/processes', auth(amyTok))).status).toBe(403);
    expect((await app.request('/brain/processes/1/output', auth(amyTok))).status).toBe(403);
    expect((await app.request('/brain/processes/1', del(amyTok))).status).toBe(403);
    expect(brain.processCalls).toEqual([]); // refused before the service is touched
    expect(brain.killProcessCalls).toEqual([]);
  });
});
