import { describe, it, expect } from 'vitest';
import {
  delegatedChannelSendOpts,
  parseDelegatedTurnRequest,
  toDelegatedProgress,
  type DelegatedTurnRequest,
} from '../../src/brain/delegatedTurn.js';
import { normalizeDelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import { IdentityResolver } from '../../src/brain/identity.js';
import type { Policy } from '../../src/plugins/policy.js';

const users = { get: (id: number) => ({ username: `u${id}`, is_admin: id === 1 }) };
const identity = new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => null, users });
const policyForProjects = (ids: number[], contributionUserId?: number): Policy => ({
  allowedProjectIds: new Set(ids),
  allowedPaths: () => [...ids.map((id) => `/repo/${id}`), ...(contributionUserId ? [`/workspace/u${contributionUserId}`] : [])],
});
const deps = { policyForProjects, identity };

const request = (): DelegatedTurnRequest => ({
  channelId: 'subagent-sub-dlg-1',
  ownerUserId: 1,
  parentSessionId: 'brain-1',
  delegatedAccess: {
    admin: false,
    projectIds: [3, 7],
    owner: true,
    // Canonical (sorted) exactly as the orchestrator mints it — see normalizeDelegatedExecutionScope.
    toolPolicy: { allow: ['Grep', 'Read'], deny: ['Bash'] },
    permissionBoundary: { rules: [{ scope: 'tools', pattern: 'Write', action: 'deny' }], unattendedAsks: 'deny' },
    promptAppend: ['You are a focused sub-agent.', 'context block'],
    contributionUserId: 2,
  },
  scheduled: false,
  model: { provider: 'e2e', model: 'mock-model' },
  thinkingLevel: 'high',
  clientCwd: '/repo/3',
  idleRolloverMs: Number.MAX_SAFE_INTEGER,
});

/** Every function value reachable from a value, by path. What the runner receives is JSON, so a closure
 *  anywhere in the payload is not "lost in transit" — it is a field that silently arrives undefined. */
function functionPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'function') return [path];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => functionPaths(child, `${path}.${key}`));
}

describe('the delegated-turn wire payload', () => {
  it('survives a JSON round-trip unchanged and carries no closure at all', () => {
    const req = request();
    expect(functionPaths(req)).toEqual([]);
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
  });

  // The three values that cannot cross a process boundary: a Policy closes over the project store, a
  // ToolPolicy holds Sets (which JSON.stringify silently flattens to `{}`), and a TurnIdentity is minted
  // against the live owner check. They are absent from the payload and derived on arrival.
  it('leaves policy, toolPolicy and identity out — they are re-derived from the captured scope', () => {
    const req = request() as unknown as Record<string, unknown>;
    expect(req.policy).toBeUndefined();
    expect(req.toolPolicy).toBeUndefined();
    expect(req.identity).toBeUndefined();
    const opts = delegatedChannelSendOpts(request(), deps);
    expect(typeof opts.policy.allowedPaths).toBe('function'); // …the reason it cannot travel
    expect(opts.toolPolicy?.allow).toBeInstanceOf(Set);
    expect(opts.identity).toEqual({ platform: 'subagent', userId: 'subagent', admin: false, owner: true, conversation: 'delegated' });
  });

  it('re-derives the SAME policy, toolPolicy and identity on the far side of the round-trip', () => {
    const here = delegatedChannelSendOpts(request(), deps);
    const parsed = parseDelegatedTurnRequest(JSON.parse(JSON.stringify(request())));
    expect(parsed).toBeDefined();
    const there = delegatedChannelSendOpts(parsed!, deps);
    expect(there.policy.allowedProjectIds).toEqual(here.policy.allowedProjectIds);
    expect(there.policy.allowedPaths()).toEqual(here.policy.allowedPaths());
    expect(there.toolPolicy).toEqual(here.toolPolicy);
    expect(there.identity).toEqual(here.identity);
    // …and every other field the channel service reads, so the child's session is composed identically.
    const comparable = (o: typeof here): unknown => ({ ...o, policy: undefined, toolPolicy: undefined });
    expect(comparable(there)).toEqual(comparable(here));
  });

  // The daemon normalizes the boundary before it dispatches and the runner normalizes it again on
  // arrival. Both hold only if normalization is idempotent — otherwise the child would execute under a
  // scope that no longer matches the one its parent minted, and the channel service would refuse it.
  it('is already canonical, so the runner re-validating it changes nothing', () => {
    expect(normalizeDelegatedExecutionScope(request().delegatedAccess)).toEqual(request().delegatedAccess);
  });

  it('carries the fields the channel service validates the scope against', () => {
    const opts = delegatedChannelSendOpts(request(), deps);
    expect(opts.trusted).toBe(false); // === scope.admin
    expect(opts.promptAppend).toEqual(['You are a focused sub-agent.', 'context block']); // === scope.promptAppend
    expect(opts.sender).toBeUndefined(); // a delegated source has no verified platform sender
    expect(opts.writerUserId).toBeUndefined(); // no private-memory identity crosses the boundary
    expect(opts.parentSessionId).toBe('brain-1');
    expect(opts.clientCwd).toBe('/repo/3');
    expect(opts.policy.allowedPaths()).toContain('/workspace/u2');
  });

  it('gives an admin scope the all-project policy without consulting the resolver', () => {
    const req = { ...request(), delegatedAccess: { ...request().delegatedAccess, admin: true, projectIds: [] } };
    const opts = delegatedChannelSendOpts(req, {
      identity,
      policyForProjects: () => { throw new Error('must not be consulted for an admin scope'); },
    });
    expect(opts.policy.allowedProjectIds).toBe('all');
    expect(opts.trusted).toBe(true);
  });

  describe('parsing a request that arrived over IPC', () => {
    it('REFUSES a turn whose delegated boundary does not normalize', () => {
      // Fail closed: running this under the caller's ambient policy is the one outcome that must be
      // impossible, so a missing/blank/corrupt boundary is not a turn at all.
      expect(parseDelegatedTurnRequest({ ...request(), delegatedAccess: undefined })).toBeUndefined();
      expect(parseDelegatedTurnRequest({ ...request(), delegatedAccess: { admin: false, projectIds: [3], owner: true } })).toBeUndefined();
      expect(parseDelegatedTurnRequest({ ...request(), parentSessionId: '' })).toBeUndefined();
      expect(parseDelegatedTurnRequest({ ...request(), ownerUserId: 0 })).toBeUndefined();
      expect(parseDelegatedTurnRequest({ ...request(), scheduled: 'yes' })).toBeUndefined();
      expect(parseDelegatedTurnRequest('nope')).toBeUndefined();
    });

    it('refuses a non-finite idle cutoff rather than inventing one', () => {
      // JSON has no Infinity — the delegate plugin pins MAX_SAFE_INTEGER for exactly this reason, so a
      // null/NaN arriving here is corruption, and silently defaulting it would roll a child's transcript
      // over mid-delegation.
      expect(parseDelegatedTurnRequest({ ...request(), idleRolloverMs: null })).toBeUndefined();
      expect(parseDelegatedTurnRequest({ ...request(), idleRolloverMs: Number.MAX_SAFE_INTEGER })?.idleRolloverMs)
        .toBe(Number.MAX_SAFE_INTEGER);
    });

    it('never carries a Fast snapshot into fresh, runner or resumed child sessions', () => {
      expect(parseDelegatedTurnRequest(request())).not.toHaveProperty('fast');
      expect(delegatedChannelSendOpts(request(), deps)).not.toHaveProperty('fast');
      // A durable request written by an older build may still contain the field. It is accepted for resume,
      // but deliberately ignored so the runner reads the contribution account's live preference instead.
      expect(parseDelegatedTurnRequest({ ...request(), fast: true })).not.toHaveProperty('fast');
      expect(delegatedChannelSendOpts(parseDelegatedTurnRequest({ ...request(), fast: true })!, deps)).not.toHaveProperty('fast');
    });
  });
});

describe('the progress events allowed across the boundary', () => {
  it('passes exactly the three low-frequency shapes the delegating plugin consumes', () => {
    expect(toDelegatedProgress({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-1' }))
      .toEqual({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-1' });
    expect(toDelegatedProgress({ type: 'tool', name: 'Bash', detail: 'ls -la', icon: 'x', id: 't1', command: 'ls -la' }))
      .toEqual({ type: 'tool', name: 'Bash', detail: 'ls -la' }); // icon/id/command are display noise
    expect(toDelegatedProgress({ type: 'step', step: 3, maxSteps: 10, usage: { tokens: 1, contextWindow: 2, percent: 3, totalTokens: 42, cost: 0 } }))
      .toMatchObject({ type: 'step', step: 3, usage: { totalTokens: 42 } });
  });

  it('drops everything else — text deltas and transcripts must never be re-amplified over IPC', () => {
    expect(toDelegatedProgress({ type: 'text', text: 'a long streamed answer' })).toBeUndefined();
    expect(toDelegatedProgress({ type: 'reasoning', text: 'private thinking' })).toBeUndefined();
    expect(toDelegatedProgress({ type: 'tool_args', id: 't1', delta: '{"path":' })).toBeUndefined();
    expect(toDelegatedProgress({ type: 'idle', model: 'm' })).toBeUndefined();
  });
});
