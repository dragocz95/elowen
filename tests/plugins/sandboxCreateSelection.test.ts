import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: 'parent',
  bindings: new Map<string, string>(),
  tools: new Map<string, { execute(id: string, input: Record<string, unknown>): Promise<any> }>(),
  workspace: { id: 'new-workspace', projectId: 1, label: 'child-work', branch: 'test/child-work', path: '/test/worktree' },
}));
const createWorkspace = vi.hoisted(() => vi.fn(async (input: Record<string, unknown>) => {
  if (input.sessionId) state.bindings.set(String(input.sessionId), state.workspace.id);
  return state.workspace;
}));
vi.mock('../../plugins/sandbox/lib/db.mjs', () => ({
  initSandboxDb: () => ({}), createExecutionLease: vi.fn(), reconcileStaleLeases: vi.fn(),
}));
vi.mock('../../plugins/sandbox/lib/execution.mjs', () => ({
  createExecutionService: () => ({}),
  migrateLegacyHomes: () => ({ collisions: [], retainedSessions: [], migrated: 0 }),
  bubblewrapProbe: vi.fn(), ensureUserHome: vi.fn(), removeUserData: vi.fn(),
}));
vi.mock('../../plugins/sandbox/lib/api.mjs', () => ({ registerSandboxApi: vi.fn() }));
vi.mock('../../plugins/sandbox/lib/workspaces.mjs', () => ({
  createWorkspaceService: () => ({
    createWorkspace,
    workspaceById: () => state.workspace,
    useWorkspace: (input: { sessionId: string; workspaceId: string }) => state.bindings.set(input.sessionId, input.workspaceId),
  }),
}));
import { register } from '../../plugins/sandbox/index.mjs';

beforeEach(async () => {
  state.session = 'parent';
  state.bindings.clear();
  state.tools.clear();
  createWorkspace.mockClear();
  await register({
    dataDir: () => '/test/data', config: {},
    currentAccountUserId: () => 1, currentSessionId: () => state.session,
    currentAccess: () => ({ admin: false, projectIds: [1] }),
    registerTurnContext: vi.fn(), registerControl: vi.fn(), registerCommand: vi.fn(), registerReadinessCheck: vi.fn(),
    registerBootReconcile: vi.fn(), registerInterval: vi.fn(), registerUserRemoved: vi.fn(),
    registerProjectRemoved: vi.fn(), registerHook: vi.fn(), logger: { info: vi.fn() },
    registerTool: (tool: any) => state.tools.set(tool.name, tool),
  });
});

const create = () => state.tools.get('SandboxCreateWorkspace')!.execute('create', { projectId: 1, label: 'child-work', baseRef: 'main' });

describe('model workspace creation does not select a conversation workspace', () => {
  it('creates without moving the parent into the worktree', async () => {
    const result = await create();
    expect(result.details.workspace.id).toBe(state.workspace.id);
    expect(createWorkspace).toHaveBeenCalledOnce();
    expect(createWorkspace.mock.calls[0]![0]).not.toHaveProperty('sessionId');
    expect(state.bindings.has('parent')).toBe(false);
  });

  it('preserves an existing explicit selection while creating another workspace', async () => {
    state.bindings.set('parent', 'user-selected');
    await create();
    expect(state.bindings.get('parent')).toBe('user-selected');
  });

  it('does not change the parent when creation comes from a child', async () => {
    state.bindings.set('parent', 'user-selected');
    state.session = 'child';
    await create();
    expect(state.bindings.get('parent')).toBe('user-selected');
    expect(state.bindings.has('child')).toBe(false);
  });

  it('still permits an explicit workspace selection', async () => {
    await create();
    await state.tools.get('SandboxUseWorkspace')!.execute('use', { workspaceId: state.workspace.id });
    expect(state.bindings.get('parent')).toBe(state.workspace.id);
  });
});
