'use client';
import { useState } from 'react';
import { Users, UserPlus, Trash2, LogOut, Shield, ShieldCheck, FolderGit2, Cpu } from 'lucide-react';
import { useUsers, useMe, useProjects, useUserProjects, useConfig } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useLogout, useAssignProject, useUpdateUser } from '../../lib/mutations';
import type { Project, User as OrcaUser } from '../../lib/types';
import { allModels } from '../../lib/execPresets';
import { execProvider, type ProviderId } from '../../lib/modelProvider';
import { PROVIDERS, providerMeta } from '../settings/providers';
import { clearToken } from '../../lib/token';
import { useToast } from '../../components/ui/Toast';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ContextMenu, ContextMenuState, DIVIDER } from '../../components/ui/ContextMenu';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { localDateTime } from '../../lib/format';

/** Admin-only: toggle chips assigning a user to projects (the access boundary for non-admins). */
function ProjectChips({ userId, projects }: { userId: number; projects: Project[] }) {
  const { t } = useTranslation();
  const assigned = useUserProjects(userId);
  const assign = useAssignProject();
  const set = new Set(assigned.data ?? []);
  if (projects.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-text-muted"><FolderGit2 size={12} aria-hidden />{t.users.projects}</span>
      {projects.map((p) => {
        const on = set.has(p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => assign.mutate({ userId, projectId: p.id, currentlyAssigned: on })}
            disabled={assign.isPending}
            className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-muted hover:bg-elevated'}`}
          >
            {p.slug}
          </button>
        );
      })}
    </div>
  );
}

/** Admin-only: restrict which models a user may run on tasks. Empty selection → no restriction
 *  (the user may use any globally-allowed model). Choices are the global allow-list, grouped the
 *  same way as the executor picker: pick the engine, then toggle its models. */
function ModelChips({ user, globalExecs, custom }: { user: OrcaUser; globalExecs: string[]; custom: { label: string; exec: string }[] }) {
  const { t } = useTranslation();
  const update = useUpdateUser();
  const { toast } = useToast();
  // Orca AI execs (`orca:<provider>/<model>`) have no preset entry — show the model part, and give
  // ModelIcon the model name so the brand mark resolves (the raw exec string matches nothing).
  const labelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label
    ?? (exec.startsWith('orca:') ? exec.slice(exec.indexOf('/') + 1) : exec);
  const iconNameOf = (exec: string) => (exec.startsWith('orca:') ? exec.slice(exec.indexOf('/') + 1) : exec);
  const set = new Set(user.allowed_execs);
  const byProvider = new Map<ProviderId, string[]>();
  for (const exec of globalExecs) {
    const prov = execProvider(exec);
    byProvider.set(prov, [...(byProvider.get(prov) ?? []), exec]);
  }
  const groups = PROVIDERS.filter((prov) => (byProvider.get(prov.id as ProviderId) ?? []).length > 0);
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null);
  const active = openProvider ?? (groups[0]?.id as ProviderId | undefined) ?? null;
  if (globalExecs.length === 0) return null;
  const toggle = (exec: string) => {
    const next = new Set(set);
    if (next.has(exec)) next.delete(exec); else next.add(exec);
    update.mutate({ id: user.id, patch: { allowed_execs: [...next] } }, {
      onSuccess: () => toast(t.users.modelsUpdated),
      onError: (e) => toast(String(e) || t.users.updateError, 'error'),
    });
  };
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide text-text-muted"><Cpu size={12} aria-hidden />{t.users.allowedModels}</span>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t.tasks.pickProvider}>
        {groups.map((prov) => {
          const meta = providerMeta(prov.id)!;
          const execs = byProvider.get(prov.id as ProviderId) ?? [];
          const picked = execs.filter((e) => set.has(e)).length;
          return (
            <button
              key={prov.id}
              type="button"
              role="tab"
              aria-selected={active === prov.id}
              onClick={() => setOpenProvider(prov.id as ProviderId)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${active === prov.id ? 'border-border-strong bg-elevated text-text' : 'border-border text-text-muted hover:bg-elevated hover:text-text'}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={meta.icon} alt="" width={13} height={13} style={{ objectFit: 'contain' }} className={meta.embedded ? 'logo-adaptive' : undefined} aria-hidden />
              {meta.label}
              {picked > 0 ? <span className="rounded bg-accent/15 px-1 font-mono text-[10px] text-accent">{picked}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-l-2 border-border pl-2.5">
        {(byProvider.get(active as ProviderId) ?? []).map((exec) => {
          const on = set.has(exec);
          return (
            <button
              key={exec}
              type="button"
              onClick={() => toggle(exec)}
              disabled={update.isPending}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-muted hover:bg-elevated'}`}
            >
              <ModelIcon name={iconNameOf(exec)} size={14} />{labelOf(exec)}
            </button>
          );
        })}
        {set.size === 0 ? <span className="text-[11px] italic text-text-muted">{t.users.allModelsHint}</span> : null}
      </div>
    </div>
  );
}

export function UsersView() {
  const users = useUsers();
  const me = useMe();
  const projects = useProjects();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const logout = useLogout();
  const config = useConfig();
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  function handleDelete(id: number) {
    deleteUser.mutate(id, {
      onSuccess: () => toast(t.users.userDeleted),
      onError: (err) => toast(String(err), 'error'),
    });
  }

  function handleCreate() {
    createUser.mutate(
      { username: newUsername, password: newPassword },
      {
        onSuccess: () => {
          toast(t.users.userCreated);
          setCreating(false);
          setNewUsername('');
          setNewPassword('');
        },
        onError: (err) => toast(String(err), 'error'),
      },
    );
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => { clearToken(); window.location.reload(); },
      // Clear token and reload even if the server call fails.
      onError: () => { clearToken(); window.location.reload(); },
    });
  }

  function handleRole(user: OrcaUser) {
    updateUser.mutate({ id: user.id, patch: { is_admin: !user.is_admin } }, {
      onSuccess: () => toast(t.users.roleUpdated),
      onError: (err) => toast(String(err) || t.users.updateError, 'error'),
    });
  }

  const data = users.data ?? [];
  // The bootstrap admin (explicit is_admin flag) manages roles, project assignments and model access.
  const isAdmin = me.data?.user?.is_admin ?? false;
  const globalExecs = config.data?.allowedExecs ?? [];
  const customModels = config.data?.customModels ?? [];

  function openCtxMenu(e: React.MouseEvent, user: OrcaUser) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(isAdmin ? [{
          label: t.users.ctxToggleAdmin,
          icon: user.is_admin ? Shield : ShieldCheck,
          onClick: () => { if (!updateUser.isPending) handleRole(user); },
        }] : []),
        ...(isAdmin ? [DIVIDER as typeof DIVIDER] : []),
        {
          label: t.users.ctxRemoveAccess,
          icon: Trash2,
          danger: true,
          onClick: () => { if (data.length > 1 && !deleteUser.isPending) handleDelete(user.id); },
          disabled: data.length <= 1,
        },
      ],
    });
  }

  return (
    <>
      <ModuleHeader title={t.page.users} count={users.data?.length} icon={Users}>
        <Button variant="ghost" icon={LogOut} onClick={handleLogout} disabled={logout.isPending}>{t.users.logout}</Button>
        <Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>
      </ModuleHeader>

      {users.isLoading ? <LoadingState />
        : users.isError ? <ErrorState message={t.users.loadError} onRetry={() => users.refetch()} />
        : data.length === 0 ? <EmptyState title={t.users.empty} description={t.users.emptyDescription} icon={Users} action={<Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>} />
        : (
          <ul className="flex flex-col gap-2.5">
            {data.map((user) => (
              <li
                key={user.id}
                className="card-interactive group flex items-center gap-3.5 rounded-lg border border-border bg-surface p-3.5"
                onContextMenu={(e) => openCtxMenu(e, user)}
              >
                <Avatar user={user} size={48} />

                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold text-text">{user.name || user.username}</span>
                    {user.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
                  </span>
                  <span className="truncate font-mono text-xs text-text-muted">@{user.username} · {localDateTime(user.created_at, locale, false)}</span>
                  {isAdmin ? <ProjectChips userId={user.id} projects={projects.data ?? []} /> : null}
                  {isAdmin ? <ModelChips user={user} globalExecs={globalExecs} custom={customModels} /> : null}
                </div>

                <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <ActionMenu
                    label={t.users.deleteLabel.replace('{username}', user.username)}
                    items={[
                      ...(isAdmin ? [{
                        label: user.is_admin ? t.users.removeAdmin : t.users.makeAdmin,
                        icon: user.is_admin ? Shield : ShieldCheck,
                        onSelect: () => { if (!updateUser.isPending) handleRole(user); },
                      }] : []),
                      {
                        label: data.length <= 1 ? t.users.lastUserHint : t.users.delete,
                        icon: Trash2,
                        tone: 'danger' as const,
                        onSelect: () => { if (data.length > 1 && !deleteUser.isPending) handleDelete(user.id); },
                      },
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

      {creating && (
        <Modal title={t.users.addUser} onClose={() => setCreating(false)} size="md" icon={UserPlus}>
          <form onSubmit={(e) => { e.preventDefault(); handleCreate(); }} className="flex min-h-0 flex-1 flex-col">
            <ModalBody gap={4}>
              <Field label={t.users.fieldUsername}>
                <Input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder={t.auth.usernamePlaceholder} autoFocus />
              </Field>
              <Field label={t.auth.passwordPlaceholder}>
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t.auth.passwordPlaceholder} />
              </Field>
            </ModalBody>
            <ModalFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
              <Button type="submit" variant="accent" icon={UserPlus} disabled={createUser.isPending || !newUsername.trim() || !newPassword}>{t.users.create}</Button>
            </ModalFooter>
          </form>
        </Modal>
      )}
      {ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}
    </>
  );
}
