import { describe, it, expect, vi } from 'vitest';
import { DecisionQueue } from '../../src/overseer/decisionQueue.js';

describe('DecisionQueue', () => {
  it('next() resolves with an enqueued request, and enqueue() resolves when decided', async () => {
    const q = new DecisionQueue();
    const verdict = q.enqueue('m1', 'task', { title: 'x' });
    const req = await q.next('m1');
    expect(req).not.toBeNull();
    expect(req!.kind).toBe('task');
    expect(req!.context).toEqual({ title: 'x' });
    expect(q.resolve('m1', req!.id, { approve: true, confidence: 0.9, rationale: 'ok' })).toBe(true);
    await expect(verdict).resolves.toMatchObject({ approve: true, confidence: 0.9 });
  });

  it('a waiting next() wakes when a request is enqueued later', async () => {
    const q = new DecisionQueue();
    const waiting = q.next('m2', 1000);
    q.enqueue('m2', 'prompt', { q: '?' });
    const req = await waiting;
    expect(req!.kind).toBe('prompt');
  });

  it('next() returns null (heartbeat) after its timeout with nothing pending', async () => {
    vi.useFakeTimers();
    const q = new DecisionQueue();
    const p = q.next('m3', 25000);
    await vi.advanceTimersByTimeAsync(25000);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('enqueue() never self-times-out — a pending decision stays pending until answered or swept', async () => {
    vi.useFakeTimers();
    const q = new DecisionQueue();
    const verdict = q.enqueue('m4', 'task', {});
    let settled = false;
    void verdict.then(() => { settled = true; });
    // A slow-but-alive overseer must not be escalated just for thinking: no timer fires it.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(false);
    vi.useRealTimers();
  });

  it('pending() lists unanswered decisions; timeout() escalates one to a human (never auto-decides)', async () => {
    const q = new DecisionQueue(() => 1000);
    const verdict = q.enqueue('m4', 'task', {});
    expect(q.pending()).toEqual([{ missionId: 'm4', id: expect.any(String), kind: 'task', enqueuedAt: 1000 }]);
    expect(q.timeout('m4', q.pending()[0]!.id)).toBe(true);
    // `escalated: true` flags "no overseer verdict — hand to a human"; consumers must NOT treat this
    // like a real reject (e.g. an L3 review must not self-heal/re-run on it).
    await expect(verdict).resolves.toEqual({ approve: false, confidence: 0, rationale: 'overseer timeout', escalated: true });
    expect(q.pending()).toEqual([]);
    // Already settled → a second timeout is a no-op (can't double-settle vs resolve/drain).
    expect(q.timeout('m4', 'whatever')).toBe(false);
  });

  it('settles the verdict with exactly what the agent answered', async () => {
    const q = new DecisionQueue();
    const verdict = q.enqueue('m6', 'task', { title: 'x' });
    const req = await q.next('m6');
    q.resolve('m6', req!.id, { approve: true, confidence: 0.9, rationale: 'looks fine' });
    await expect(verdict).resolves.toEqual({ approve: true, confidence: 0.9, rationale: 'looks fine' });
  });

  it('carries the overseer-picked choice through a question verdict', async () => {
    const q = new DecisionQueue();
    const verdict = q.enqueue('mq', 'question', { question: 'which port?', options: [{ id: '1', label: 'a' }, { id: '2', label: 'b' }] });
    const req = await q.next('mq');
    expect(req!.kind).toBe('question');
    q.resolve('mq', req!.id, { approve: false, confidence: 0.9, rationale: 'docs-only', choice: '2' });
    await expect(verdict).resolves.toMatchObject({ choice: '2', confidence: 0.9 });
  });

  it('carries the overseer free-text reply through a message verdict', async () => {
    const q = new DecisionQueue();
    const verdict = q.enqueue('mm', 'message', { question: 'A or B?' });
    const req = await q.next('mm');
    expect(req!.kind).toBe('message');
    q.resolve('mm', req!.id, { approve: false, confidence: 0, rationale: '', message: 'use A' });
    await expect(verdict).resolves.toMatchObject({ message: 'use A' });
  });

  it('a question that times out carries no choice (⇒ the deriver escalates)', async () => {
    const q = new DecisionQueue();
    const verdict = q.enqueue('mqt', 'question', { question: '?' });
    q.timeout('mqt', q.pending()[0]!.id);
    const v = await verdict;
    expect(v.choice).toBeUndefined();
  });

  it('drain() escalates all pending for a mission', async () => {
    const q = new DecisionQueue();
    const a = q.enqueue('m5', 'task', {});
    q.drain('m5');
    await expect(a).resolves.toMatchObject({ approve: false, rationale: 'mission disengaged' });
  });
});
