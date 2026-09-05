// The sandbox plugin's own endpoints, as the `/sandbox` chat drawer reads and writes them
// (`GET /plugins/sandbox/api/overview` plus the four `workspaces/*` writes). Separate from
// `pluginSurfaces.ts` because this one is not a canned answer: the drawer is a WRITING surface, so the
// fake keeps state — which conversation is bound where, which workspaces exist — and the writes move it.
//
// WHAT IT MODELS, and why each piece is there:
//   - two projects with a workspace each, so the drawer's per-project grouping has something to group;
//   - one CLEAN workspace bound to the default conversation (the "active here" marker) and one DIRTY one
//     with untracked files, ahead/behind counts and a live process (the badge row, and the state the
//     release refusal is derived from);
//   - `workspaces/remove` refusing an unclean tree with the plugin's own coded error
//     `{ error: 'workspace_not_clean' }`, which is the refusal the drawer maps to its blocked sentence.
//     The refusal is derived from the fixture's state rather than armed by a flag, exactly as the real
//     plugin derives it — asking to remove the dirty workspace is what produces it.
//
// WHAT IT DOES NOT PROVE: the shapes are structural mirrors of the plugin's wire types (web/lib/types.ts),
// not the plugin's server code. They make the DRAWER verifiable; the plugin's own tests own its routes.
import type { Hono } from 'hono';
import type {
  SandboxOverview,
  SandboxProject,
  SandboxSession,
  SandboxWorkspace,
} from '../../../../lib/types.ts';
import { DEFAULT_SESSION_ID } from '../../seed/fixtures.ts';

/** The workspace the default conversation already works in — clean, so removing it would succeed. */
export const CLEAN_WORKSPACE_ID = 'ws-atlas-payments';
/** The workspace with uncommitted work in it — the one whose removal the daemon refuses. */
export const DIRTY_WORKSPACE_ID = 'ws-kolin-catalog';

// `defaultRef` is the repository's real default branch as the daemon read it. The second project has
// none, which is the case the create form must not paper over with a guessed branch name.
const projects: SandboxProject[] = [
  { id: 1, slug: 'atlas', path: '/srv/atlas', defaultRef: 'main' },
  { id: 2, slug: 'kolin', path: '/srv/kolin', defaultRef: null },
];

const sessions: SandboxSession[] = [
  { id: DEFAULT_SESSION_ID, title: 'First conversation', updatedAt: '2026-07-15T10:00:00.000Z' },
  { id: 'brain-2', title: 'Second conversation', updatedAt: '2026-07-14T09:00:00.000Z' },
];

function seedWorkspaces(): SandboxWorkspace[] {
  return [
    {
      id: CLEAN_WORKSPACE_ID,
      userId: 1,
      projectId: 1,
      label: 'payment refactor',
      path: '/srv/atlas-worktrees/payment-refactor',
      branch: 'sbx/payment-refactor',
      baseRef: 'main',
      lifecycle: 'active',
      orphanReason: null,
      createdAt: '2026-08-01T08:00:00.000Z',
      updatedAt: '2026-09-01T08:00:00.000Z',
      lastUsedAt: '2026-09-01T08:00:00.000Z',
      accessible: true,
      status: {
        branch: 'sbx/payment-refactor', head: 'a1b2c3d', upstream: 'origin/sbx/payment-refactor',
        ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true,
      },
      files: [],
      uniqueCommits: 0,
      activeProcesses: 0,
      // Bound to the conversation the chat surface opens on, so the drawer marks it "active here".
      bindings: [{ sessionId: DEFAULT_SESSION_ID, updatedAt: '2026-09-01T08:00:00.000Z' }],
    },
    {
      id: DIRTY_WORKSPACE_ID,
      userId: 1,
      projectId: 2,
      label: 'catalog spike',
      path: '/srv/kolin-worktrees/catalog-spike',
      branch: 'sbx/catalog-spike',
      baseRef: 'develop',
      lifecycle: 'active',
      orphanReason: null,
      createdAt: '2026-08-20T08:00:00.000Z',
      updatedAt: '2026-09-02T08:00:00.000Z',
      lastUsedAt: '2026-09-02T08:00:00.000Z',
      accessible: true,
      status: {
        branch: 'sbx/catalog-spike', head: 'f4e5d6c', upstream: 'origin/develop',
        ahead: 2, behind: 1, dirty: 3, untracked: 2, clean: false,
      },
      files: [
        { path: 'src/catalog/price.ts', code: ' M', untracked: false },
        { path: 'src/catalog/notes.md', code: '??', untracked: true },
      ],
      uniqueCommits: 2,
      // A live process in this one, so a conversation that switches INTO it has something the release
      // route must refuse — the same lease guard removal already answers with.
      activeProcesses: 1,
      bindings: [],
    },
  ];
}

let workspaces: SandboxWorkspace[] = seedWorkspaces();

/** One write the drawer posted, recorded so a spec can assert the EXACT payload — the whole point of the
 *  switch and create assertions is that the right ids travelled, not merely that something was posted. */
export type SandboxCall =
  | { kind: 'create'; projectId?: number; label?: string; baseRef?: string; at: number }
  | { kind: 'use'; workspaceId?: string; sessionId?: string; at: number }
  | { kind: 'release'; sessionId?: string; at: number }
  | { kind: 'remove-preview'; workspaceId?: string; at: number }
  | { kind: 'remove'; workspaceId?: string; at: number };

const calls: SandboxCall[] = [];

/** Read-only view of the sandbox writes the UI posted (exposed via `GET /__test/sandbox-calls`). */
export function sandboxCalls(): readonly SandboxCall[] {
  return calls;
}

/** Restore the seed workspaces and drop the recorded writes (the control channel's `/__test/reset`). */
export function resetSandbox(): void {
  workspaces = seedWorkspaces();
  calls.length = 0;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

export function registerSandboxRoutes(app: Hono): void {
  app.get('/plugins/sandbox/api/overview', (c) => {
    const overview: SandboxOverview = { projects, sessions, workspaces };
    return c.json(overview);
  });

  app.post('/plugins/sandbox/api/workspaces/create', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const projectId = num(body.projectId);
    const label = str(body.label);
    const baseRef = str(body.baseRef);
    calls.push({ kind: 'create', ...(projectId !== undefined ? { projectId } : {}), ...(label ? { label } : {}), ...(baseRef ? { baseRef } : {}), at: Date.now() });
    if (projectId === undefined || !label || !baseRef) return c.json({ error: 'invalid_input' }, 400);
    const now = new Date().toISOString();
    const workspace: SandboxWorkspace = {
      id: `ws-created-${workspaces.length + 1}`,
      userId: 1,
      projectId,
      label,
      path: `/srv/worktrees/${label.replace(/\s+/g, '-')}`,
      branch: `sbx/${label.replace(/\s+/g, '-')}`,
      baseRef,
      lifecycle: 'active',
      orphanReason: null,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: now,
      accessible: true,
      status: { branch: `sbx/${label.replace(/\s+/g, '-')}`, head: '0000000', upstream: null, ahead: 0, behind: 0, dirty: 0, untracked: 0, clean: true },
      files: [],
      uniqueCommits: 0,
      activeProcesses: 0,
      bindings: [],
    };
    workspaces = [...workspaces, workspace];
    return c.json({ workspace });
  });

  // Point one conversation at one workspace. A conversation works in exactly one worktree, so the
  // binding MOVES rather than accumulates — which is what makes the drawer's "active here" marker travel.
  app.post('/plugins/sandbox/api/workspaces/use', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    const sessionId = str(body.sessionId);
    calls.push({ kind: 'use', ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}), at: Date.now() });
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!target || !sessionId) return c.json({ error: 'workspace_not_found' }, 404);
    const updatedAt = new Date().toISOString();
    workspaces = workspaces.map((w) => {
      const bindings = w.bindings.filter((b) => b.sessionId !== sessionId);
      return w.id === workspaceId
        ? { ...w, bindings: [...bindings, { sessionId, updatedAt }] }
        : { ...w, bindings };
    });
    return c.json({ workspace: workspaces.find((w) => w.id === workspaceId) });
  });

  // The inverse of `use`: drop this conversation's bindings and KEEP every workspace, which is what makes
  // the "active here" marker disappear while both rows stay in the list. A workspace with a live process
  // is refused with the plugin's own coded error, the same shape the removal refusal takes.
  app.post('/plugins/sandbox/api/workspaces/release', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const sessionId = str(body.sessionId);
    calls.push({ kind: 'release', ...(sessionId ? { sessionId } : {}), at: Date.now() });
    if (!sessionId) return c.json({ error: 'session_required' }, 400);
    const bound = workspaces.filter((w) => w.bindings.some((b) => b.sessionId === sessionId));
    if (bound.some((w) => w.activeProcesses > 0)) return c.json({ error: 'workspace_in_use' }, 409);
    workspaces = workspaces.map((w) => ({ ...w, bindings: w.bindings.filter((b) => b.sessionId !== sessionId) }));
    return c.json({ released: bound.length });
  });

  app.post('/plugins/sandbox/api/workspaces/remove-preview', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    calls.push({ kind: 'remove-preview', ...(workspaceId ? { workspaceId } : {}), at: Date.now() });
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!target) return c.json({ error: 'workspace_not_found' }, 404);
    return c.json({
      workspaceId: target.id,
      head: target.status?.head ?? '0000000',
      dirty: target.status?.dirty ?? 0,
      untracked: target.status?.untracked ?? 0,
      uniqueCommits: target.uniqueCommits,
      activeProcesses: target.activeProcesses,
      files: target.files.map((f) => f.path),
    });
  });

  // The SAFE removal, which is the only one the drawer ever asks for. An unclean tree is refused with the
  // plugin's coded error and the workspace stays exactly where it is.
  app.post('/plugins/sandbox/api/workspaces/remove', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = str(body.workspaceId);
    calls.push({ kind: 'remove', ...(workspaceId ? { workspaceId } : {}), at: Date.now() });
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!target) return c.json({ error: 'workspace_not_found' }, 404);
    if (!target.status?.clean || target.uniqueCommits > 0) return c.json({ error: 'workspace_not_clean' }, 409);
    workspaces = workspaces.filter((w) => w.id !== workspaceId);
    return c.json({ removed: target.id });
  });
}
