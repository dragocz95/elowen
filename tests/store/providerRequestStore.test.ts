import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (id, username, password_hash, name) VALUES (7, 'seven', 'x', 'Seven'), (8, 'eight', 'x', 'Eight')").run();
  const brain = new BrainStore(db);
  brain.createSession({ id: 's1', userId: 7, model: 'm', provider: 'configured' });
  brain.createSession({ id: 's2', userId: 8, model: 'm', provider: 'configured' });
  return { db, brain, requests: brain.providerRequests };
}

const body = (tools: unknown[] = [{ name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]) => ({
  model: 'wire-model',
  system: [{ type: 'text', text: 'system' }],
  messages: [{ role: 'user', content: 'hello' }],
  tools,
  temperature: 0,
});

function start(brain: BrainStore, sessionId = 's1', payload: unknown = body()) {
  return brain.providerRequests.start({
    sessionId, turnId: 'turn:1', kind: 'chat', configuredProvider: 'configured',
    wireProvider: 'anthropic', api: 'anthropic-messages', model: 'wire-model', payload, startedAt: 1_000,
  });
}

function finish(brain: BrainStore, requestId: string) {
  brain.providerRequests.markResponse(requestId, 200, 1_010);
  brain.providerRequests.finish({
    requestId, status: 'succeeded', finishedAt: 1_020,
    response: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    usage: { input: 10, output: 3, reasoning: 2, cacheRead: 4, cacheWrite: 5, totalTokens: 24, cost: { total: 0.12 } },
  });
}

describe('ProviderRequestStore', () => {
  it('reconstructs the final provider body and deduplicates stable prompt/tool segments per session', () => {
    const { db, brain, requests } = fixture();
    const first = start(brain);
    finish(brain, first.requestId);
    const second = requests.start({
      sessionId: 's1', turnId: 'turn:2', kind: 'chat', configuredProvider: 'configured',
      wireProvider: 'anthropic', api: 'anthropic-messages', model: 'wire-model',
      payload: { ...body(), messages: [...body().messages, { role: 'assistant', content: 'next' }] }, startedAt: 2_000,
    });

    expect(requests.reconstruct(first.requestId)).toEqual(body());
    expect(requests.reconstruct(second.requestId)).toEqual({
      ...body(), messages: [...body().messages, { role: 'assistant', content: 'next' }],
    });
    expect(db.prepare("SELECT COUNT(*) n FROM brain_request_segments WHERE session_id = 's1' AND kind = 'system'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM brain_request_segments WHERE session_id = 's1' AND kind = 'tool'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM brain_request_segments WHERE session_id = 's1' AND kind = 'input'").get()).toEqual({ n: 2 });
  });

  it('captures the exact dynamic tool set separately for each request', () => {
    const { brain, requests } = fixture();
    const first = start(brain, 's1', body([]));
    finish(brain, first.requestId);
    const dynamic = { name: 'mcp__repo__search', description: 'Search', input_schema: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } };
    const second = requests.start({
      sessionId: 's1', turnId: 'turn:2', kind: 'chat', configuredProvider: 'configured',
      wireProvider: 'anthropic', api: 'anthropic-messages', model: 'wire-model', payload: body([dynamic]),
    });

    expect((requests.reconstruct(first.requestId) as { tools: unknown[] }).tools).toEqual([]);
    expect((requests.reconstruct(second.requestId) as { tools: unknown[] }).tools).toEqual([dynamic]);
  });

  it('previews the visible answer of a message rather than its reasoning block or raw JSON', () => {
    const { brain, requests } = fixture();
    const attempt = start(brain, 's1', {
      ...body(),
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Weighing two options.' }, { type: 'text', text: 'Stálo to 4,12 USD.' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Reasoning only, no answer yet.' }] },
      ],
    });
    const segments = requests.debugRequest('s1', attempt.requestId)!.segments.filter((s) => s.section === 'input');

    expect(segments[0]).toMatchObject({ role: 'assistant', preview: 'Stálo to 4,12 USD.' });
    // A reasoning-only message still previews its text instead of serializing the block.
    expect(segments[1]).toMatchObject({ role: 'assistant', preview: 'Reasoning only, no answer yet.' });
  });

  it('fails loudly rather than opening overlapping attempts or accepting an orphan response', () => {
    const { brain, requests } = fixture();
    const first = start(brain);
    expect(() => start(brain)).toThrow(/pending attempt/);
    expect(() => requests.markResponse('missing', 200)).toThrow(/response without one pending attempt/);
    requests.finish({ requestId: first.requestId, status: 'error', errorMessage: 'boom' });
  });

  it('accounts terminal requests once and keeps interruption/error counts in the session summary', () => {
    const { db, brain, requests } = fixture();
    const first = start(brain);
    finish(brain, first.requestId);
    expect(requests.finish({ requestId: first.requestId, status: 'succeeded' })).toBe(false);
    const second = requests.start({
      sessionId: 's1', turnId: 'turn:2', retryOf: first.requestId, kind: 'chat', configuredProvider: 'configured',
      wireProvider: 'anthropic', api: 'anthropic-messages', model: 'wire-model', payload: body(), startedAt: 2_000,
    });
    requests.finish({ requestId: second.requestId, status: 'error', errorCode: 'stream', errorMessage: 'dropped', finishedAt: 2_010 });

    expect(db.prepare("SELECT request_count, error_count, total_tokens, cost_usd, costed_request_count FROM brain_request_session_summary WHERE session_id = 's1'").get())
      .toEqual({ request_count: 2, error_count: 1, total_tokens: 24, cost_usd: 0.12, costed_request_count: 1 });
  });

  it('marks pending attempts interrupted on the next database boot without accounting them twice', () => {
    const home = mkdtempSync(join(tmpdir(), 'elowen-provider-capture-'));
    homes.push(home);
    const path = join(home, 'elowen.db');
    const firstDb = openDb(path);
    const firstBrain = new BrainStore(firstDb);
    firstBrain.createSession({ id: 's1', userId: 7, model: 'm' });
    const attempt = start(firstBrain);
    firstDb.close();

    const secondDb = openDb(path);
    const row = secondDb.prepare('SELECT status, error_code, duration_ms FROM brain_provider_requests WHERE request_id = ?').get(attempt.requestId) as { status: string; error_code: string; duration_ms: number };
    expect(row).toMatchObject({ status: 'interrupted', error_code: 'daemon_restart' });
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(secondDb.prepare("SELECT request_count, error_count FROM brain_request_session_summary WHERE session_id = 's1'").get())
      .toEqual({ request_count: 1, error_count: 1 });
    secondDb.close();
  });

  it('lists managed sessions and requests with stable cursors and indexed filters', () => {
    const { db, brain, requests } = fixture();
    db.prepare("UPDATE brain_sessions SET updated_at = '2026-08-19 20:00:00' WHERE id = 's1'").run();
    db.prepare("UPDATE brain_sessions SET updated_at = '2026-08-18 20:00:00' WHERE id = 's2'").run();
    const first = start(brain);
    finish(brain, first.requestId);
    const second = requests.start({
      sessionId: 's1', turnId: 'turn:2', kind: 'compaction', configuredProvider: 'configured',
      wireProvider: 'anthropic', api: 'anthropic-messages', model: 'wire-model', payload: body(), startedAt: 2_000,
    });
    requests.finish({ requestId: second.requestId, status: 'error', errorMessage: 'overflow', finishedAt: 2_010 });

    const sessions = requests.debugSessions({ limit: 1 });
    expect(sessions.items[0]).toMatchObject({ id: 's1', username: 'seven', requestCount: 2, errorCount: 1, latestRequestStatus: 'error' });
    expect(sessions.captureStartedAt).toBe(1_000);
    expect(sessions.nextCursor).toBeTruthy();
    expect(requests.debugSessions({ cursor: sessions.nextCursor!, limit: 1 }).items[0]?.id).toBe('s2');
    expect(requests.debugSessions({ status: 'legacy' }).items.map((item) => item.id)).toEqual(['s2']);
    expect(requests.debugSessions({ search: 'seven', provider: 'configured', model: 'wire-model', status: 'error' }).items).toHaveLength(1);
    start(brain, 's2');
    expect(requests.debugSessions({ status: 'captured' }).items.map((item) => item.id)).toContain('s2');
    expect(requests.debugSessions({ status: 'legacy' }).items).toEqual([]);
    expect(requests.debugSession('s2')?.captureStartedAt).not.toBeNull();

    const requestPage = requests.debugRequests('s1', { limit: 1 });
    expect(requestPage?.items[0]).toMatchObject({ requestId: first.requestId, seq: 1, status: 'succeeded' });
    expect(requests.debugRequests('s1', { cursor: requestPage!.nextCursor!, limit: 1 })?.items[0])
      .toMatchObject({ requestId: second.requestId, seq: 2, kind: 'compaction' });
    expect(requests.debugRequests('missing')).toBeUndefined();
  });

  it('loads manifests and payloads lazily, enforces byte limits, and reconstructs the exact body', () => {
    const { db, brain, requests } = fixture();
    const attempt = start(brain);
    finish(brain, attempt.requestId);

    const detail = requests.debugRequest('s1', attempt.requestId)!;
    expect(detail.segments.map((segment) => segment.section)).toEqual(['system', 'input', 'tool', 'options', 'response']);
    expect(detail.segments[0]).toMatchObject({ role: 'system', label: 'system', preview: 'system' });
    expect(detail.segments[1]).toMatchObject({ role: 'user', label: 'user', preview: 'hello' });
    expect(detail.segments[2]).toMatchObject({ role: 'tool', label: 'Read', preview: 'Read' });
    expect(detail.segmentBytes).toBeGreaterThan(0);
    let metadataReads = 0;
    const originalPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (/SELECT kind, digest, canonicalization_version, byte_length, estimated_tokens/.test(sql)) metadataReads += 1;
      return originalPrepare(sql);
    }) as typeof db.prepare;
    const firstPage = requests.debugSegmentPayloads('s1', attempt.requestId, { limit: 2, maxBytes: 1_000_000 })!;
    expect(firstPage.items).toHaveLength(2);
    expect(metadataReads).toBe(1);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(requests.debugSegmentPayloads('s1', attempt.requestId, { cursor: firstPage.nextCursor!, maxBytes: 1_000_000 })!.items.length).toBeGreaterThan(0);
    expect(requests.debugSegmentPayload('s1', attempt.requestId, 1, 1_000_000)).toMatchObject({ index: 1, payload: { role: 'user', content: 'hello' } });
    expect(() => requests.debugSegmentPayload('s1', attempt.requestId, 1, 1)).toThrow(/byte limit/);
    expect(() => requests.debugSegmentPayloads('s1', attempt.requestId, { maxBytes: 1 })).toThrow(/byte limit/);
    const raw = requests.debugRawPayload('s1', attempt.requestId, 1_000_000)!;
    expect(raw.payload).toEqual(body());
    expect(raw.byteLength).toBeGreaterThan(0);
    expect(() => requests.debugRawPayload('s1', attempt.requestId, 1)).toThrow(/byte limit/);
    expect(requests.debugRequest('s2', attempt.requestId)).toBeUndefined();
  });

  it('pages the best-effort legacy transcript by session and byte budget', () => {
    const { brain } = fixture();
    brain.appendMessage({ id: 'm1', sessionId: 's2', parentId: null, role: 'user', content: { text: 'first' } });
    brain.appendMessage({ id: 'm2', sessionId: 's2', parentId: null, role: 'assistant', content: { text: 'second' } });
    const first = brain.debugLegacyTranscript('s2', { limit: 1, maxBytes: 1_000 })!;
    expect(first).toMatchObject({ exact: false, items: [{ id: 'm1', role: 'user', content: { text: 'first' } }] });
    expect(first.nextCursor).toBeTruthy();
    expect(brain.debugLegacyTranscript('s2', { cursor: first.nextCursor!, limit: 1, maxBytes: 1_000 })?.items[0]?.id).toBe('m2');
    expect(() => brain.debugLegacyTranscript('s2', { maxBytes: 1 })).toThrow(/byte limit/);
    expect(brain.debugLegacyTranscript('missing')).toBeUndefined();
  });

  it('follows delete, clear, rekey, fork, user deletion, retention delete, and usage reset lifecycle', () => {
    const { db, brain, requests } = fixture();
    const first = start(brain);
    finish(brain, first.requestId);

    brain.reassignSession('s1', 'archived');
    expect(requests.rows('s1')).toEqual([]);
    expect(requests.rows('archived')).toHaveLength(1);
    expect(requests.reconstruct(first.requestId)).toEqual(body());

    const fork = brain.forkSession('archived', 'fork');
    expect(fork.forked_from_session_id).toBe('archived');
    expect(requests.rows('fork')).toEqual([]);

    brain.clearUsage(7);
    expect(requests.row(first.requestId)).toMatchObject({ total_tokens: null, cost_usd: null });
    expect(db.prepare("SELECT request_count, total_tokens, cost_usd, costed_request_count FROM brain_request_session_summary WHERE session_id = 'archived'").get())
      .toEqual({ request_count: 1, total_tokens: 0, cost_usd: 0, costed_request_count: 0 });
    expect(requests.reconstruct(first.requestId)).toEqual(body());

    brain.clearSessionHistory('archived');
    expect(requests.rows('archived')).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) n FROM brain_request_segments WHERE session_id = 'archived'").get()).toEqual({ n: 0 });

    const retained = requests.start({
      sessionId: 'fork', turnId: 'turn:1', kind: 'chat', configuredProvider: '', wireProvider: 'p', api: 'a', model: 'm', payload: body(),
    });
    requests.finish({ requestId: retained.requestId, status: 'succeeded' });
    brain.appendMessage({ id: 'fork-u1', sessionId: 'fork', parentId: null, role: 'user', content: 'retention candidate' });
    db.prepare("UPDATE brain_sessions SET updated_at = datetime('now', '-20 days') WHERE id = 'fork'").run();
    expect(brain.staleConversationIds(7, 10)).toContain('fork');
    brain.deleteSession('fork');
    expect(requests.rows('fork')).toEqual([]);

    const other = start(brain, 's2');
    requests.finish({ requestId: other.requestId, status: 'succeeded' });
    brain.removeForUser(8);
    expect(requests.rows('s2')).toEqual([]);
  });
});
