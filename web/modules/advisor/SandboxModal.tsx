'use client';

import { useMemo, useState } from 'react';
import { Boxes, FolderGit2, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useSandboxOverview } from '../../lib/queries';
import {
  useCreateSandboxWorkspace,
  useRemoveSandboxWorkspace,
  useSandboxRemovalPreview,
  useUseSandboxWorkspace,
} from '../../lib/mutations';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../lib/elowenClient';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { SelectMenu } from '../../components/ui/SelectMenu';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Badge } from '../../components/ui/shadcn/badge';
import type { SandboxOverview, SandboxRemovalPreview, SandboxWorkspace } from '../../lib/types';

/** The plugin's coded removal refusals, mapped to the sentence each one is reported with.
 *
 *  These are the three the SAFE removal path can answer with (see `removeWorkspace` in the plugin's
 *  `lib/workspaces.mjs`). Anything else falls back to the generic sentence rather than showing a code:
 *  what the reader needs to know is that nothing was removed, which is true of every refusal. */
const BLOCKED_REASONS = {
  workspace_in_use: 'blockedInUse',
  workspace_not_clean: 'blockedNotClean',
  workspace_changed: 'blockedChanged',
} as const;

type CreateDraft = { projectId: string; label: string; baseRef: string };

/** One workspace, as a row that states where it is and what is in it.
 *
 *  Switching this conversation is the move the drawer is opened for, so it is the row's own button.
 *  Removal is rare and destructive and lives behind the ⋯ menu, exactly as deleting a task does — a row
 *  with a delete button in it is a row people press by accident. */
function WorkspaceRow({ workspace, projectName, activeHere, busy, canSwitch, onUse, onRemove }: {
  workspace: SandboxWorkspace;
  projectName: string;
  activeHere: boolean;
  busy: boolean;
  canSwitch: boolean;
  onUse: (workspace: SandboxWorkspace) => void;
  onRemove: (workspace: SandboxWorkspace) => void;
}) {
  const { t } = useTranslation();
  const status = workspace.status;
  const usable = workspace.accessible && workspace.lifecycle === 'active';
  const items: ActionMenuItem[] = [
    { label: t.sandboxModal.remove, icon: Trash2, tone: 'danger', onSelect: () => onRemove(workspace) },
  ];

  return (
    <div
      data-testid="sandbox-workspace-row"
      className="flex flex-col gap-2 bg-card px-3 py-2.5"
      // The conversation works in exactly one of these. `aria-current` is what says so to a reader who
      // never sees the badge beside it.
      {...(activeHere ? { 'aria-current': 'true' as const } : {})}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{workspace.label}</span>
        <Button
          variant={activeHere ? 'ghost' : 'default'}
          size="sm"
          disabled={busy || activeHere || !usable || !canSwitch}
          aria-label={`${t.sandboxModal.use}: ${workspace.label}`}
          onClick={() => onUse(workspace)}
        >
          {t.sandboxModal.use}
        </Button>
        <ActionMenu
          items={items}
          label={`${t.sandboxModal.workspaceActions}: ${workspace.label}`}
          align="right"
          trigger={<MoreHorizontal size={15} aria-hidden />}
          triggerClassName="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        />
      </div>

      <div className="flex flex-col gap-0.5 text-xs">
        <span className="truncate text-muted-foreground">{projectName}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{workspace.branch}</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{workspace.baseRef}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {activeHere ? <Badge variant="soft-primary">{t.sandboxModal.activeHere}</Badge> : null}
        {!activeHere && workspace.bindings.length > 0 ? <Badge variant="secondary">{t.sandboxModal.activeElsewhere}</Badge> : null}
        {workspace.lifecycle === 'orphaned' || !workspace.accessible ? <Badge variant="soft-destructive">{t.sandboxModal.orphaned}</Badge> : null}
        {status?.clean ? <Badge variant="soft-success">{t.sandboxModal.clean}</Badge> : null}
        {(status?.dirty ?? 0) > 0 ? <Badge variant="soft-warning">{interpolate(t.sandboxModal.dirty, { n: status?.dirty ?? 0 })}</Badge> : null}
        {(status?.untracked ?? 0) > 0 ? <Badge variant="soft-warning">{interpolate(t.sandboxModal.untracked, { n: status?.untracked ?? 0 })}</Badge> : null}
        {(status?.ahead ?? 0) > 0 ? <Badge variant="secondary">{interpolate(t.sandboxModal.ahead, { n: status?.ahead ?? 0 })}</Badge> : null}
        {(status?.behind ?? 0) > 0 ? <Badge variant="secondary">{interpolate(t.sandboxModal.behind, { n: status?.behind ?? 0 })}</Badge> : null}
        {workspace.activeProcesses > 0 ? <Badge variant="soft-warning">{interpolate(t.sandboxModal.processes, { n: workspace.activeProcesses })}</Badge> : null}
      </div>
    </div>
  );
}

export function SandboxModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { activeSessionId } = useBrainChat();
  const overview = useSandboxOverview();
  const createWorkspace = useCreateSandboxWorkspace();
  const switchWorkspace = useUseSandboxWorkspace();
  const removalPreview = useSandboxRemovalPreview();
  const removeWorkspace = useRemoveSandboxWorkspace();

  const [draft, setDraft] = useState<CreateDraft | null>(null);
  /** The workspace a removal has been started for, together with the preview that says what it holds.
   *  Both are needed before the question can be asked, which is why they travel as one piece of state:
   *  a confirmation that cannot yet state what it would remove is not a confirmation. */
  const [pendingRemoval, setPendingRemoval] = useState<{ workspace: SandboxWorkspace; preview: SandboxRemovalPreview } | null>(null);
  /** The refusal the daemon answered the last removal attempt with. It stays in the open confirmation so
   *  the reader learns why the workspace is still there, instead of watching the dialog close on nothing. */
  const [blocked, setBlocked] = useState<string | null>(null);

  const data: SandboxOverview | undefined = overview.data;
  const projects = useMemo(() => data?.projects ?? [], [data?.projects]);
  const workspaces = useMemo(() => data?.workspaces ?? [], [data?.workspaces]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.slug])), [projects]);
  const nameOfProject = (projectId: number): string => projectNames.get(projectId) ?? `#${projectId}`;

  /** The workspaces grouped under the project they were cut from, in the overview's project order, with
   *  any project the overview did not name last. A flat list of worktrees says nothing about which
   *  repository each one belongs to, and a person usually has several per project. */
  const groups = useMemo(() => {
    const byProject = new Map<number, SandboxWorkspace[]>();
    for (const workspace of workspaces) {
      const bucket = byProject.get(workspace.projectId);
      if (bucket) bucket.push(workspace);
      else byProject.set(workspace.projectId, [workspace]);
    }
    const ordered = projects.filter((project) => byProject.has(project.id)).map((project) => project.id);
    const rest = [...byProject.keys()].filter((id) => !ordered.includes(id));
    return [...ordered, ...rest].map((projectId) => ({
      projectId,
      name: nameOfProject(projectId),
      rows: byProject.get(projectId) ?? [],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, projects, projectNames]);

  const isActiveHere = (workspace: SandboxWorkspace): boolean =>
    !!activeSessionId && workspace.bindings.some((binding) => binding.sessionId === activeSessionId);

  const mutating = createWorkspace.isPending || switchWorkspace.isPending || removalPreview.isPending || removeWorkspace.isPending;

  /** The reference a new workspace is cut from, as the OVERVIEW states it for that project. The daemon
   *  reads the repository's real default branch and answers null when there is none, so a null leaves the
   *  field empty and the reader supplies the ref — a guessed `main` here silently branched from a name
   *  that need not exist. */
  const defaultRefOf = (projectId: string): string =>
    projects.find((project) => String(project.id) === projectId)?.defaultRef ?? '';

  const openCreate = (): void => {
    const projectId = String(projects[0]?.id ?? '');
    setDraft({ projectId, label: '', baseRef: defaultRefOf(projectId) });
  };

  const runCreate = (): void => {
    if (!draft) return;
    const projectId = Number(draft.projectId);
    const label = draft.label.trim();
    const baseRef = draft.baseRef.trim();
    if (!Number.isSafeInteger(projectId) || !label || !baseRef) return;
    createWorkspace.mutate({ projectId, label, baseRef }, {
      onSuccess: (result) => {
        setDraft(null);
        toast(interpolate(t.sandboxModal.created, { label: result.workspace.label }), 'ok');
      },
      onError: (error: Error) => toast(apiErrorMessage(error), 'error'),
    });
  };

  /** Point this conversation at a workspace. The id sent is the conversation's, and the daemon derives
   *  the working directory from the binding it writes — nothing about a directory is stored here. */
  const runUse = (workspace: SandboxWorkspace): void => {
    if (!activeSessionId) { toast(t.sandboxModal.useNoSession, 'error'); return; }
    switchWorkspace.mutate({ workspaceId: workspace.id, sessionId: activeSessionId }, {
      onSuccess: () => toast(interpolate(t.sandboxModal.switched, { label: workspace.label }), 'ok'),
      onError: (error: Error) => toast(apiErrorMessage(error), 'error'),
    });
  };

  /** Ask what removal would take with it, and only then raise the question. */
  const startRemoval = (workspace: SandboxWorkspace): void => {
    setBlocked(null);
    removalPreview.mutate({ workspaceId: workspace.id }, {
      onSuccess: (preview) => setPendingRemoval({ workspace, preview }),
      onError: () => toast(t.sandboxModal.removePreviewError, 'error'),
    });
  };

  /** The SAFE removal. A refusal leaves the workspace exactly where it is and is reported in the open
   *  confirmation; the drawer never retries with `discard`, which is what would throw work away. */
  const runRemoval = (): void => {
    if (!pendingRemoval) return;
    const { workspace } = pendingRemoval;
    setBlocked(null);
    removeWorkspace.mutate({ workspaceId: workspace.id }, {
      onSuccess: () => {
        setPendingRemoval(null);
        toast(interpolate(t.sandboxModal.removed, { label: workspace.label }), 'ok');
      },
      onError: (error: Error) => {
        const code = apiErrorMessage(error) as keyof typeof BLOCKED_REASONS;
        setBlocked(t.sandboxModal[BLOCKED_REASONS[code] ?? 'blockedFallback']);
      },
    });
  };

  const removalDescription = pendingRemoval ? [
    interpolate(t.sandboxModal.removeDescription, {
      label: pendingRemoval.workspace.label,
      project: nameOfProject(pendingRemoval.workspace.projectId),
      branch: pendingRemoval.workspace.branch,
    }),
    interpolate(t.sandboxModal.dirty, { n: pendingRemoval.preview.dirty }),
    interpolate(t.sandboxModal.untracked, { n: pendingRemoval.preview.untracked }),
    interpolate(t.sandboxModal.uniqueCommits, { n: pendingRemoval.preview.uniqueCommits }),
    interpolate(t.sandboxModal.processes, { n: pendingRemoval.preview.activeProcesses }),
  ].join('\n') : undefined;

  return (
    <>
      {/* `inspect`: the worktrees this conversation can be moved between, read beside the conversation
          itself. On a phone the shared presentation rule turns it into the fullscreen overlay — see
          overlayDepth.tsx — so a long list scrolls to its last row under the pinned header, and the
          removal confirmation below stands a level deeper and takes the screen, which is what a
          destructive question should do. */}
      <Modal
        title={t.sandboxModal.modalTitle}
        onClose={onClose}
        size="md"
        icon={Boxes}
        intent="inspect"
        headerActions={
          <Button
            variant="ghost"
            size="sm"
            icon={RefreshCw}
            disabled={overview.isFetching}
            aria-label={t.sandboxModal.refresh}
            onClick={() => void overview.refetch()}
          >
            {t.sandboxModal.refresh}
          </Button>
        }
      >
        <ModalBody gap={4}>
          {draft ? (
            <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
              {/* Create makes a worktree and nothing else: the conversation stays where it is until the
                  reader switches it from a row. The form says so BEFORE the press, because the two
                  surfaces differed on exactly this and the drawer's own toast is read afterwards. */}
              <p className="text-xs text-muted-foreground">{t.sandboxModal.createHint}</p>
              <Field label={t.sandboxModal.project}>
                <SelectMenu
                  value={draft.projectId}
                  // The base reference belongs to the project it is read from, so it follows the choice
                  // rather than leaving another project's default behind in the field.
                  onChange={(projectId) => setDraft({ ...draft, projectId, baseRef: defaultRefOf(projectId) })}
                  label={t.sandboxModal.project}
                  options={projects.map((project) => ({ value: String(project.id), label: project.slug }))}
                />
              </Field>
              <Field label={t.sandboxModal.label}>
                <Input
                  autoFocus
                  value={draft.label}
                  placeholder={t.sandboxModal.labelPlaceholder}
                  aria-label={t.sandboxModal.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
              </Field>
              {/* Required, and empty whenever the project states no default branch — the form asks for
                  the ref instead of branching from a name nobody confirmed exists. */}
              <Field
                label={t.sandboxModal.baseRef}
                required
                {...(defaultRefOf(draft.projectId) ? {} : { description: t.sandboxModal.baseRefUnknown })}
              >
                {(control) => (
                  <Input
                    {...control}
                    value={draft.baseRef}
                    placeholder={t.sandboxModal.baseRefPlaceholder}
                    aria-label={t.sandboxModal.baseRef}
                    className="font-mono"
                    onChange={(event) => setDraft({ ...draft, baseRef: event.target.value })}
                  />
                )}
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>{t.common.cancel}</Button>
                <Button
                  variant="accent"
                  size="sm"
                  disabled={createWorkspace.isPending || !draft.projectId || !draft.label.trim() || !draft.baseRef.trim()}
                  onClick={runCreate}
                >
                  {t.sandboxModal.createSubmit}
                </Button>
              </div>
            </div>
          ) : null}

          {overview.isLoading ? (
            <LoadingState variant="list" />
          ) : overview.isError ? (
            <ErrorState message={t.sandboxModal.loadError} onRetry={() => void overview.refetch()} />
          ) : workspaces.length === 0 ? (
            <EmptyState title={t.sandboxModal.emptyTitle} description={t.sandboxModal.emptyDesc} icon={FolderGit2} />
          ) : (
            groups.map((group) => (
              <section key={group.projectId} className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.name}</h3>
                <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
                  {group.rows.map((workspace) => (
                    <WorkspaceRow
                      key={workspace.id}
                      workspace={workspace}
                      projectName={group.name}
                      activeHere={isActiveHere(workspace)}
                      busy={mutating}
                      canSwitch={!!activeSessionId}
                      onUse={runUse}
                      onRemove={startRemoval}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="accent"
            icon={Plus}
            disabled={projects.length === 0 || draft !== null || createWorkspace.isPending}
            onClick={openCreate}
          >
            {t.sandboxModal.create}
          </Button>
        </ModalFooter>
      </Modal>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={t.sandboxModal.removeTitle}
        description={removalDescription}
        confirmLabel={t.sandboxModal.remove}
        pendingLabel={t.sandboxModal.removePending}
        pending={removeWorkspace.isPending}
        {...(blocked ? { error: blocked } : {})}
        onConfirm={runRemoval}
        onClose={() => { setPendingRemoval(null); setBlocked(null); }}
      />
    </>
  );
}
