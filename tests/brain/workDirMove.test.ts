import { afterAll, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveSessionWorkDir, projectMoveTarget, switchableProjects } from '../../src/brain/service/workDir.js';
import { ChannelSessionService } from '../../src/brain/channels.js';
import { channelSessionId } from '../../src/brain/sessionId.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { openDb } from '../../src/store/db.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { KnownControls } from '../../src/plugins/api.js';

const ALL: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });
const tmpDir = (tag: string): string => { const dir = mkdtempSync(join(tmpdir(), `ps-${tag}-`)); tempDirs.push(dir); return realpathSync(dir); };

function liveWith(sessionId: string, workDir: string | undefined): LiveBrain {
  return {
    sessionId, workDir,
    replay: { publish: vi.fn() } as never,
  } as LiveBrain;
}

describe('moveSessionWorkDir', () => {
  it('persists the durable home, moves the live record and queues one cwd notice', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: 'hi' });
    const launched = tmpDir('launch');
    const dest = tmpDir('dest');
    const live = liveWith('brain-1', launched);

    const moved = moveSessionWorkDir({ store, policy: ALL, accountUserId: 1, sessionId: 'brain-1', live, workDir: dest });

    expect(moved).toEqual({ workDir: dest, moved: true, released: 0 });
    // The whole point of the shared move: a cold respawn (daemon restart, plugin reload) restores the
    // stored work_dir, so the durable home must follow the live one or the move silently reverts.
    expect(store.getSession('brain-1')?.work_dir).toBe(dest);
    expect(live.workDir).toBe(dest);
    expect(store.getSessionEvents('brain-1').map((e) => e.kind)).toEqual(['cwd']);
    expect(live.pendingSessionNotices).toEqual([`changed the working directory to ${dest}`]);
  });

  it('refuses a directory the policy does not reach and moves nothing', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    const launched = tmpDir('launch');
    const outside = tmpDir('outside');
    const live = liveWith('brain-1', launched);
    const policy: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [launched] };

    expect(() => moveSessionWorkDir({ store, policy, accountUserId: 1, sessionId: 'brain-1', live, workDir: outside }))
      .toThrow(/not readable or not allowed/);

    expect(store.getSession('brain-1')?.work_dir).toBe('');
    expect(live.workDir).toBe(launched);
    expect(store.getSessionEvents('brain-1')).toEqual([]);
  });

  it('releases the sandbox bindings that do not belong to the destination project', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    const dest = tmpDir('dest');
    const live = liveWith('brain-1', undefined);
    const release = vi.fn(() => ({ released: 2 }));
    const sandbox = { releaseSessionWorkspaces: release, workspaceRoots: () => [] } as unknown as KnownControls['sandbox'];
    const projects = { list: () => [{ id: 7, slug: 'dest', path: dest }] };

    moveSessionWorkDir({ store, policy: ALL, accountUserId: 3, sessionId: 'brain-1', live, workDir: dest, projects, sandbox });

    expect(release).toHaveBeenCalledWith({ sessionId: 'brain-1', projectIds: [7], keepProjectId: 7 });
    expect(live.workDir).toBe(dest);
  });

  it('propagates a workspace_in_use refusal before anything moves', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: 'hi' });
    const launched = tmpDir('launch');
    const dest = tmpDir('dest');
    const live = liveWith('brain-1', launched);
    const release = vi.fn(() => { throw new Error('workspace_in_use: a process is running in the bound worktree'); });
    const sandbox = { releaseSessionWorkspaces: release, workspaceRoots: () => [] } as unknown as KnownControls['sandbox'];
    const projects = { list: () => [{ id: 7, slug: 'dest', path: dest }] };

    expect(() => moveSessionWorkDir({ store, policy: ALL, accountUserId: 3, sessionId: 'brain-1', live, workDir: dest, projects, sandbox }))
      .toThrow(/workspace_in_use/);

    expect(live.workDir).toBe(launched);
    expect(store.getSession('brain-1')?.work_dir).toBe('');
  });

  it('persists the durable home even when the conversation is not live', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: 'hi' });
    const dest = tmpDir('dest');

    const moved = moveSessionWorkDir({ store, policy: ALL, accountUserId: 1, sessionId: 'brain-1', workDir: dest });

    expect(moved.moved).toBe(true);
    expect(store.getSession('brain-1')?.work_dir).toBe(dest);
    // A marker still lands (there is no stream to publish on and no agent to tell), exactly like a
    // rename from the picker while the conversation is cold.
    expect(store.getSessionEvents('brain-1').map((e) => e.kind)).toEqual(['cwd']);
  });

  it('stays silent when the conversation is already in the requested directory', () => {
    const store = new BrainStore(openDb(':memory:'));
    store.createSession({ id: 'brain-1', userId: 1, title: 'T', model: 'm' });
    store.appendMessage({ id: 'm1', sessionId: 'brain-1', parentId: null, role: 'user', content: 'hi' });
    const dest = tmpDir('dest');
    const live = liveWith('brain-1', undefined);

    moveSessionWorkDir({ store, policy: ALL, accountUserId: 1, sessionId: 'brain-1', live, workDir: dest });
    const again = moveSessionWorkDir({ store, policy: ALL, accountUserId: 1, sessionId: 'brain-1', live, workDir: dest });

    expect(again).toEqual({ workDir: dest, moved: false, released: 0 });
    expect(store.getSessionEvents('brain-1').filter((e) => e.kind === 'cwd')).toHaveLength(1);
    expect(live.pendingSessionNotices).toHaveLength(1);
  });
});

describe('project resolvers', () => {
  it('projectMoveTarget resolves a reachable project with its slug', () => {
    const path = tmpDir('proj');
    const projects = { list: () => [{ id: 7, slug: 'kolin', path }] };

    expect(projectMoveTarget(ALL, projects, 7)).toEqual({ workDir: path, slug: 'kolin' });
  });

  it('projectMoveTarget refuses a project the caller does not reach or whose path is gone', () => {
    const reachable = tmpDir('reachable');
    const vanished = join(tmpDir('base'), 'gone');
    const projects = { list: () => [{ id: 1, slug: 'gone', path: vanished }, { id: 7, slug: 'kolin', path: reachable }] };
    const policy: Policy = { allowedProjectIds: new Set([7]), allowedPaths: () => [reachable] };

    expect(projectMoveTarget(policy, projects, 1)).toBeUndefined(); // outside the policy
    expect(projectMoveTarget(policy, projects, 2)).toBeUndefined(); // not a project at all
    expect(projectMoveTarget(policy, { list: () => [{ id: 3, slug: 'lost', path: vanished }] }, 3)).toBeUndefined();
  });

  it('switchableProjects lists only the projects the caller reaches', () => {
    const first = tmpDir('first');
    const second = tmpDir('second');
    const outside = tmpDir('outside');
    const projects = { list: () => [
      { id: 1, slug: 'first', path: first },
      { id: 2, slug: 'second', path: second },
      { id: 3, slug: 'secret', path: outside },
    ] };
    const policy: Policy = { allowedProjectIds: new Set([1, 2]), allowedPaths: () => [first, second] };

    expect(switchableProjects(policy, projects)).toEqual([
      { id: 1, slug: 'first', path: first },
      { id: 2, slug: 'second', path: second },
    ]);
    expect(switchableProjects(policy, undefined)).toEqual([]);
  });

  it('projectMoveTarget refuses a project the caller is not assigned to, even one nested in an allowed root', () => {
    // A project registered inside another project's root — or inside a supplemental Sandbox root —
    // clears the path-containment gate by accident; the project ASSIGNMENT is what says the caller
    // may be moved there at all.
    const parent = tmpDir('parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const supplemental = tmpDir('sandbox-root');
    const workspace = join(supplemental, 'ws');
    mkdirSync(workspace, { recursive: true });
    const projects = { list: () => [
      { id: 1, slug: 'parent', path: parent },
      { id: 2, slug: 'nested', path: nested },
      { id: 3, slug: 'sandboxed', path: workspace },
      { id: 4, slug: 'sandbox-assigned', path: supplemental },
    ] };
    const policy: Policy = { allowedProjectIds: new Set([1, 4]), allowedPaths: () => [parent, supplemental] };

    expect(projectMoveTarget(policy, projects, 2)).toBeUndefined(); // nested in project 1, but not assigned
    expect(projectMoveTarget(policy, projects, 3)).toBeUndefined(); // nested in the sandbox root, but not assigned
    expect(projectMoveTarget(policy, projects, 1)).toEqual({ workDir: parent, slug: 'parent' });
    expect(projectMoveTarget(policy, projects, 4)).toEqual({ workDir: supplemental, slug: 'sandbox-assigned' });
  });

  it('switchableProjects omits unassigned projects even when their paths sit inside allowed roots', () => {
    const parent = tmpDir('p-parent');
    const nested = join(parent, 'nested');
    mkdirSync(nested, { recursive: true });
    const supplemental = tmpDir('p-sandbox');
    mkdirSync(join(supplemental, 'ws'), { recursive: true });
    const projects = { list: () => [
      { id: 1, slug: 'parent', path: parent },
      { id: 2, slug: 'nested', path: nested },
      { id: 3, slug: 'sandboxed', path: join(supplemental, 'ws') },
    ] };
    const policy: Policy = { allowedProjectIds: new Set([1]), allowedPaths: () => [parent, supplemental] };

    expect(switchableProjects(policy, projects)).toEqual([{ id: 1, slug: 'parent', path: parent }]);
  });
});

/** A channel harness in the channelControl.test.ts style: a REAL BrainStore plus a fake live record,
 *  so the persisted row and the live cwd are both observable after a switch. */
function channelHarness(channelLive: { sessionId: string; workDir?: string } | undefined, extra: Record<string, unknown> = {}) {
  const store = new BrainStore(openDb(':memory:'));
  const registry = new LiveSessionRegistry<LiveBrain>();
  let ch: LiveBrain | undefined;
  if (channelLive) {
    ch = liveWith(channelLive.sessionId, channelLive.workDir);
    registry.channelTouch('discord-c1', ch);
  }
  store.createSession({ id: channelSessionId('discord-c1'), userId: 1, title: 'T', model: 'm' });
  store.appendMessage({ id: 'm1', sessionId: channelSessionId('discord-c1'), parentId: null, role: 'user', content: 'hi' });
  const svc = new ChannelSessionService({
    registry, store,
    cards: { forSession: () => [] } as never,
    users: { get: () => ({ username: 'o' }) },
    spawn: vi.fn(async () => { throw new Error('not used'); }),
    ...extra,
  } as never);
  return { svc, store, ch };
}

describe('ChannelSessionService.switchProject', () => {
  it('moves the live channel conversation into the project, persists it and queues the notice', async () => {
    const dest = tmpDir('dest');
    const { svc, store, ch } = channelHarness({ sessionId: channelSessionId('discord-c1'), workDir: tmpDir('launch') }, {
      projects: { list: () => [{ id: 7, slug: 'kolin', path: dest }] },
    });

    const moved = await svc.switchProject('discord-c1', { policy: ALL, accountUserId: 3, projectId: 7 });

    expect(moved).toEqual({ workDir: dest, slug: 'kolin' });
    expect(store.getSession(channelSessionId('discord-c1'))?.work_dir).toBe(dest);
    expect(ch?.workDir).toBe(dest);
    expect(ch?.pendingSessionNotices).toEqual([`changed the working directory to ${dest}`]);
  });

  it('refuses a project the caller does not reach and moves nothing', async () => {
    const reachable = tmpDir('reachable');
    const secret = tmpDir('secret');
    const { svc, store, ch } = channelHarness({ sessionId: channelSessionId('discord-c1'), workDir: tmpDir('launch') }, {
      projects: { list: () => [{ id: 7, slug: 'kolin', path: reachable }, { id: 8, slug: 'secret', path: secret }] },
    });
    const policy: Policy = { allowedProjectIds: new Set([7]), allowedPaths: () => [reachable] };

    await expect(svc.switchProject('discord-c1', { policy, accountUserId: 3, projectId: 8 })).rejects.toThrow(/not readable or not allowed/);
    expect(store.getSession(channelSessionId('discord-c1'))?.work_dir).toBe('');
    expect(ch?.workDir).not.toBe(secret);
  });

  it('persists the durable home even when the channel is not live', async () => {
    const dest = tmpDir('dest');
    const { svc, store } = channelHarness(undefined, {
      projects: { list: () => [{ id: 7, slug: 'kolin', path: dest }] },
    });

    const moved = await svc.switchProject('discord-c1', { policy: ALL, accountUserId: 3, projectId: 7 });

    expect(moved).toEqual({ workDir: dest, slug: 'kolin' });
    expect(store.getSession(channelSessionId('discord-c1'))?.work_dir).toBe(dest);
  });

  it('refuses an unknown project', async () => {
    const { svc } = channelHarness({ sessionId: channelSessionId('discord-c1') }, {
      projects: { list: () => [] },
    });
    await expect(svc.switchProject('discord-c1', { policy: ALL, accountUserId: 3, projectId: 99 })).rejects.toThrow();
  });
});

describe('platform control project methods', () => {
  it('are exposed on the control surface and keyed like a message', async () => {
    const { PlatformOrchestrator } = await import('../../src/brain/platforms.js');
    const { IdentityResolver } = await import('../../src/brain/identity.js');
    const users = { get: (id: number) => ({ username: `u${id}` }) };
    const identity = new IdentityResolver({ platformOwner: () => 1, resolvePlatformUser: () => ({ id: 2, name: 'Amy', username: 'amy', admin: false }), users });
    let control: Record<string, unknown> | undefined;
    const adapter = {
      name: 'discord', listen: () => {}, connect: async () => {},
      control: (api: unknown) => { control = api as Record<string, unknown>; },
    };
    const listed: { platform: string; sender: string }[] = [];
    const switched: { platform: string; sender: string; channelKey: string; projectId: number }[] = [];
    const orch = new PlatformOrchestrator({
      plugins: async () => ({ platforms: [adapter] }) as never,
      platformOwner: () => 1,
      policyForUser: () => ALL,
      identity,
      channels: { sessionOwnerUserId: () => undefined, send: async () => 'ok', fragmentFor: () => '' } as never,
      dispatch: { send: () => Promise.reject(new Error('this test must not delegate')) },
      listProjects: (platform: string, sender: string) => { listed.push({ platform, sender }); return [{ id: 7, slug: 'kolin', path: '/repo/7' }]; },
      switchProject: async (platform: string, sender: string, channelKey: string, projectId: number) => {
        switched.push({ platform, sender, channelKey, projectId });
        return { workDir: '/repo/7', slug: 'kolin' };
      },
    } as never);
    await orch.startAll();

    expect(control?.listProjects).toBeTypeOf('function');
    expect(control?.switchProject).toBeTypeOf('function');

    const ref = { platform: 'discord', channelId: 'c1' };
    const listedResult = await (control?.listProjects as (ref: unknown, sender: string) => unknown)(ref, 'D2');
    expect(listedResult).toEqual([{ id: 7, slug: 'kolin', path: '/repo/7' }]);
    expect(listed).toEqual([{ platform: 'discord', sender: 'D2' }]);

    const switchResult = await (control?.switchProject as (ref: unknown, sender: string, projectId: number) => Promise<unknown>)(ref, 'D2', 7);
    expect(switchResult).toEqual({ workDir: '/repo/7', slug: 'kolin' });
    expect(switched).toEqual([{ platform: 'discord', sender: 'D2', channelKey: 'discord-c1', projectId: 7 }]);
  });
});