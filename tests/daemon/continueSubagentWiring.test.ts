import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import { BrainService, type BrainDeps } from '../../src/brain/brainService.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import { inMemoryModelRuntime } from '../../src/brain/providers.js';
import { createDelegatedChildren } from '../../src/daemon/brainCore.js';
import type { DelegatedExecutionScope } from '../../src/brain/delegatedScope.js';
import type { DelegatedChildBridge, SubagentProgressEvent } from '../../src/plugins/api.js';
import type { SubagentUpdate } from '../../src/brain/events.js';

let sharedRuntime: ModelRuntime;
beforeAll(async () => { sharedRuntime = await inMemoryModelRuntime(); });

/** The turn-scope access type the registry mints for the delegating turn (the bridge's 4th argument). */
type DelegatedAccess = Parameters<DelegatedChildBridge['continue']>[3];

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

const SCOPE: DelegatedExecutionScope = { admin: true, projectIds: [], owner: true, permissionBoundary: null };
const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-abc';

/** A live brain with one owner conversation and one idle delegated child under it. The parent row is
 *  seeded straight into the store (the owner-turn spawn is not part of this chain) and
 *  `channelService.send` is stubbed at the same seam brainService.test.ts uses — everything from the
 *  bridge's core call down to the send opts is the REAL implementation. */
function setup(scope: DelegatedExecutionScope = SCOPE, sandbox?: Record<string, unknown>) {
  const store = new BrainStore(openDb(':memory:'));
  store.createSession({ id: PARENT, userId: 1, model: 'm' });
  store.createSession({
    id: CHILD, userId: 1, model: 'k3', provider: 'kimi-coding',
    parentSessionId: PARENT, delegatedAccess: scope,
  });
  const deps: BrainDeps = {
    store,
    runtime: sharedRuntime,
    users: { ensureAdvisorToken: () => 'tok', get: () => ({ name: 'Filip', username: 'filip' }) },
    config: { providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['m'], apiKey: 'k' }] },
    prompts: { render: () => '' },
    url: 'http://x',
    ...(sandbox ? { plugins: { peek: () => ({ control: (name: string) => name === 'sandbox' ? sandbox : undefined }) } as never } : {}),
  };
  const svc = new BrainService(deps);
  const send = vi.fn(async () => 'the sub-agent answered');
  (svc as unknown as { channelService: { send: unknown } }).channelService.send = send;
  return { store, svc, send };
}

// The chain under test: plugins/subagent DelegateContinue → registry ctx.continueSubagent →
// delegatedChildren.continue → brain.continueSubagent → sendDelegated → channelService.send. The middle
// hop is the REAL createDelegatedChildren bridge (extracted from buildApp so this suite can reach it):
// the parent anchor comes from the host turn, the child id from the tool, and the remaining arguments
// are forwarded positionally — model AFTER onEvent. A swapped (parent, child) pair typechecks (both
// strings), so this test pins the order on the production code itself. Everything else here is real.
async function loadRegistry(store: BrainStore, svc: BrainService) {
  return loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
    delegatedChildren: createDelegatedChildren(store, svc),
  });
}

describe('DelegateContinue wiring — plugin tool to the brain core', () => {
  it('carries parent, child, text, access, onEvent and model to the core, in that order', async () => {
    const { store, svc, send } = setup();
    // Records the bridge→core call while still running the real implementation through to sendDelegated.
    const continueSpy = vi.spyOn(svc, 'continueSubagent');
    const reg = await loadRegistry(store, svc);
    const tool = reg.tools.find((t) => t.name === 'DelegateContinue');
    if (!tool) throw new Error('DelegateContinue tool is not registered');
    const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> };

    const updates: SubagentUpdate[] = [];
    // The turn carries a tool deny-list; the continuation must layer it onto the resumed child policy
    // (never widen) and the access the registry mints must carry it for the bridge to forward.
    const res = await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-42', { id: CHILD, message: 'also check the tests', model: 'anthropic/claude-sonnet-5' }),
      { identity: owner, sessionId: PARENT, toolPolicy: { deny: new Set(['Bash']) }, emitSubagent: (u) => updates.push(u) },
    );

    expect(res.content[0]?.text).toBe('the sub-agent answered');

    // The registry anchored the continuation on the CURRENT conversation, never on anything the plugin
    // supplied, and forwarded the remaining arguments positionally. model comes AFTER onEvent — the
    // position the 31. 7. feature added — so a swapped pair here is exactly what must fail.
    expect(continueSpy).toHaveBeenCalledTimes(1);
    const [parent, child, text, access, onEvent, model] = continueSpy.mock.calls[0] as unknown as [
      string, string, string, DelegatedAccess,
      ((e: SubagentProgressEvent) => void) | undefined, string | undefined,
    ];
    expect(parent).toBe(PARENT);
    expect(child).toBe(CHILD);
    expect(text).toBe('also check the tests');
    // The access object is the delegating turn's OWN scope, minted by the registry — not a plugin value.
    expect(access).toMatchObject({ admin: true, owner: true, projectIds: [] });
    expect(access.permissionBoundary).toBeNull();
    expect(access.toolPolicy).toEqual({ deny: ['Bash'] });
    expect(typeof onEvent).toBe('function');
    expect(model).toBe('anthropic/claude-sonnet-5');

    // The same meaning at the deepest real point: the child's own channel, its durable parent edge, and
    // the tool's model override split on the first slash. The override reaching the send opts is what
    // proves the model parameter survived every hop, not just arrived somewhere.
    expect(send).toHaveBeenCalledTimes(1);
    const [opts, sentText] = send.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(sentText).toBe('also check the tests');
    expect(opts.channelId).toBe('subagent-sub-dlg-abc');
    expect(opts.parentSessionId).toBe(PARENT);
    expect(opts.ownerSteer).toBe(true);
    expect(opts.idleRolloverMs).toBe(Number.POSITIVE_INFINITY);
    expect(opts.model).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    // The current turn's tool denies are layered onto the resumed child's policy — they ride the chain
    // from the toolPolicy the registry read out of the turn scope, down to the send opts. AskUserQuestion
    // rides along on top: delegatedToolPolicy() denies interactive tools unconditionally, because a
    // resumed child runs unattended and a question it parks on would never reach a person.
    expect(opts.toolPolicy).toEqual({ deny: new Set(['AskUserQuestion', 'Bash']) });

    // The progress callback is the SAME object wired end to end: the plugin's onEvent → brain narrowing
    // → the send-opts onEvent → back into the plugin's rail state → the host's updates. Driving the send
    // opts callback directly proves the round trip, not just that a function was passed around.
    const childEvents = opts.onEvent as ((e: unknown) => void) | undefined;
    expect(childEvents).toBeDefined();
    expect(updates[0]).toMatchObject({ id: 'call-42', sessionId: CHILD, status: 'running' });
    expect(updates.at(-1)).toMatchObject({ status: 'done' });
    childEvents?.({ type: 'tool', name: 'Read', detail: 'a.ts', icon: 'x' });
    expect(updates.some((u) => u.status === 'running' && u.tools === 1 && u.detail === 'Read a.ts')).toBe(true);
  });

  // Promotion is the one thing a continuation can WIDEN, so it must never be reachable as a side effect of
  // an ordinary follow-up: the flag has to travel the whole chain explicitly, and the access the gate is
  // measured against has to be the registry's own, carrying the principal it will be checked on.
  it('promotes only when the tool was explicitly asked to, and never otherwise', async () => {
    const { store, svc } = setup();
    const continueSpy = vi.spyOn(svc, 'continueSubagent');
    const reg = await loadRegistry(store, svc);
    const tool = reg.tools.find((t) => t.name === 'DelegateContinue');
    if (!tool) throw new Error('DelegateContinue tool is not registered');
    const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> };
    const run = (params: Record<string, unknown>): Promise<{ content: { text: string }[] }> => runWithPolicy(
      adminPolicy,
      () => executor.execute('call-44', { id: CHILD, message: 'now do it', ...params }),
      { identity: owner, sessionId: PARENT },
    );

    await run({});
    await run({ write_access: false });
    expect(continueSpy.mock.calls.map((call) => call[6])).toEqual([false, false]);

    const res = await run({ write_access: true });
    expect(continueSpy.mock.calls[2]?.[6]).toBe(true);
    expect((continueSpy.mock.calls[2]?.[3] as DelegatedAccess & { principal?: string }).principal).toBe('elowen:1');
    // This child records no read-only origin (it is the plain scope every other case here uses), so the
    // request is refused rather than granted — the fail-closed default for anything unmarked.
    expect(res.content[0]?.text).toMatch(/cannot give that sub-agent write access/);
  });

  it('attaches a legacy child to workspaceId once and persists only the durable ref', async () => {
    const scope: DelegatedExecutionScope = {
      admin: true, projectIds: [], owner: true, permissionBoundary: null, contributionUserId: 1,
    };
    const sandbox = {
      workspacesFor: () => [{ workspaceId: 'ws_attach', projectId: 3, path: '/host/ws', label: 'w', branch: 'b', baseRef: 'main' }],
      resolveWorkspace: () => ({ accountUserId: 1, workspaceId: 'ws_attach', projectId: 3, path: '/host/ws' }),
    };
    const { store, svc, send } = setup(scope, sandbox);
    const reg = await loadRegistry(store, svc);
    const tool = reg.tools.find((candidate) => candidate.name === 'DelegateContinue');
    if (!tool) throw new Error('DelegateContinue tool is not registered');
    const executor = tool as unknown as { execute(id: string, p: unknown): Promise<{ content: { text: string }[] }> };
    const definition = tool as unknown as { parameters: { properties: Record<string, unknown> } };
    expect(definition.parameters.properties).toHaveProperty('workspaceId');

    await runWithPolicy(adminPolicy, () => executor.execute('call-workspace', {
      id: CHILD, message: 'continue in the worktree', workspaceId: 'ws_attach',
    }), { identity: owner, sessionId: PARENT, contributionUserId: 1 });

    expect(store.delegatedAccessFor(CHILD)?.workspaceRef).toEqual({ workspaceId: 'ws_attach', projectId: 3 });
    const [opts] = send.mock.calls[0] as unknown as [{ delegatedAccess: DelegatedExecutionScope }];
    expect(opts.delegatedAccess.workspaceRef).toEqual({ workspaceId: 'ws_attach', projectId: 3 });
    expect(JSON.stringify(opts.delegatedAccess)).not.toContain('/host/ws');
  });

  it('continues on the child\'s recorded row model when the tool passes none', async () => {
    const { store, svc, send } = setup();
    const continueSpy = vi.spyOn(svc, 'continueSubagent');
    const reg = await loadRegistry(store, svc);
    const tool = reg.tools.find((t) => t.name === 'DelegateContinue');
    if (!tool) throw new Error('DelegateContinue tool is not registered');
    const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> };

    await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-43', { id: CHILD, message: 'carry on' }),
      { identity: owner, sessionId: PARENT },
    );

    const [, , , , , model] = continueSpy.mock.calls[0] as unknown as [
      string, string, string, DelegatedAccess,
      ((e: SubagentProgressEvent) => void) | undefined, string | undefined,
    ];
    expect(model).toBeUndefined();
    const [opts] = send.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(opts.model).toEqual({ model: 'k3', provider: 'kimi-coding' });
  });
});
