import { describe, it, expect } from 'vitest';
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

function fakeBrain() {
  const started = new Set<number>();
  const sends: { id: number; text: string; mode?: string }[] = [];
  const boundSendCalls: { session?: string; client?: { id: string; generation: number } }[] = [];
  const fastCalls: { id: number; on?: boolean; session?: string }[] = [];
  const stopSessionCalls: { id: number; session?: string; client?: string; generation?: number }[] = [];
  const startCalls: { id: number; opts?: { fresh?: boolean; clientId?: string; clientGeneration?: number } }[] = [];
  const tapSnapshotCalls: { id: number; session: string }[] = [];
  const subagentSends: { id: number; session: string; text: string }[] = [];
  const acceptedSendFailures: { session: string; message: string }[] = [];
  const turnRequests: Omit<TurnRequest, 'onAdmitted'>[] = [];
  let subagentPreflightError: Error | null = null;
  let sendBeforeAdmissionError: Error | null = null;
  let sendAfterAdmissionError: Error | null = null;
  let blockSends = false;
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
    startCalls,
    tapSnapshotCalls,
    subagentSends,
    acceptedSendFailures,
    turnRequests,
    __failSubagentPreflight: (message: string | null) => { subagentPreflightError = message ? new Error(message) : null; },
    __failSendBeforeAdmission: (message: string | null) => { sendBeforeAdmissionError = message ? new Error(message) : null; },
    __failSendAfterAdmission: (message: string | null) => { sendAfterAdmissionError = message ? new Error(message) : null; },
    __blockSends: () => { blockSends = true; },
    /** Test helper: seed a user's pending mid-turn queue. */
    __enqueue: (id: number, item: { id: string; text: string }) => { queues.set(id, [...(queues.get(id) ?? []), item]); },
    status: (id: number) => ({ running: started.has(id), sessionId: started.has(id) ? `brain-${id}` : null, model: 'm', queued: queues.get(id) ?? [], fast: false, fastAvailable: true }),
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
    tapSessionSnapshot: (id: number, session: string, listener: (event: { type: 'text'; delta: string }) => void) => {
      tapSnapshotCalls.push({ id, session });
      // Arrives after the atomic snapshot was captured but while its first SSE frame is flushing.
      queueMicrotask(() => listener({ type: 'text', delta: 'post-snapshot event' }));
      return {
        off: () => {},
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
    history: (_id: number) => [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }],
    messagesOf: () => [],
    preflightSubagentSend: () => { if (subagentPreflightError) throw subagentPreflightError; },
    sendToSubagent: async (id: number, session: string, text: string) => { subagentSends.push({ id, session, text }); },
    searchMessages: (id: number, q: string) =>
      q.trim().length < 2 ? [] : [{ sessionId: `s-${id}`, sessionTitle: 'T', role: 'user', snippet: q, ts: '2026-01-01 00:00:00' }],
  };
}

function setup() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  users.create('admin', 'pw');
  const amy = users.create('amy', 'pw');
  const config = new ConfigStore(db);
  const brain = fakeBrain();
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db), bus: new EventBus(),
    engine: null as never, spawn: null as never, tmux: null as never,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config, users, projects: new ProjectStore(db), userProjects: new UserProjectStore(db),
    brain: brain as never,
  });
  return { app, amyTok: users.issueToken(amy.id), agentTok: users.issueToken(amy.id, 'agent'), brain };
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
    expect(body).toContain('stored child turn');
    expect(body).toContain('running child output');
    expect(body).toContain('post-snapshot event');
    expect(body.indexOf('running child output')).toBeLessThan(body.indexOf('post-snapshot event'));
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
