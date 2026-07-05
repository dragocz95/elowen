'use client';
import { useState } from 'react';
import { FolderGit2, Cpu, Wrench, ShieldCheck } from 'lucide-react';
import { useUserProjects } from '../../lib/queries';
import { useAssignProject, useUpdateUser } from '../../lib/mutations';
import type { Project, User as OrcaUser } from '../../lib/types';
import { allModels } from '../../lib/execPresets';
import { execProvider, type ProviderId } from '../../lib/modelProvider';
import { PROVIDERS, providerMeta } from '../settings/providers';
import { useToast } from '../../components/ui/Toast';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { HelpTip } from '../../components/ui/HelpTip';
import { useTranslation } from '../../lib/i18n';
import { localDateTime } from '../../lib/format';
import { ToolPills } from './ToolPills';
import { UserStatsInline } from './UserStatsInline';

/** Admin-only: toggle chips assigning a user to projects (the access boundary for non-admins). */
function ProjectChips({ userId, projects }: { userId: number; projects: Project[] }) {
  const assigned = useUserProjects(userId);
  const assign = useAssignProject();
  const set = new Set(assigned.data ?? []);
  if (projects.length === 0) return <p className="text-xs italic text-text-muted">—</p>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
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

/** Admin-only: restrict which models a user may run on tasks. Empty selection → no restriction. Choices
 *  are the global allow-list, grouped like the executor picker: pick the engine, then toggle its models. */
function ModelChips({ user, globalExecs, custom }: { user: OrcaUser; globalExecs: string[]; custom: { label: string; exec: string }[] }) {
  const { t } = useTranslation();
  const update = useUpdateUser();
  const { toast } = useToast();
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
  if (globalExecs.length === 0) return <p className="text-xs italic text-text-muted">—</p>;
  const toggle = (exec: string) => {
    const next = new Set(set);
    if (next.has(exec)) next.delete(exec); else next.add(exec);
    update.mutate({ id: user.id, patch: { allowed_execs: [...next] } }, {
      onSuccess: () => toast(t.users.modelsUpdated),
      onError: (e) => toast(String(e) || t.users.updateError, 'error'),
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
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

/** A labeled block within the detail pane. `hint` renders as a hover "?" (HelpTip), not inline text. */
function Block({ icon: Icon, title, hint, children }: { icon: typeof FolderGit2; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <Icon size={13} aria-hidden />{title}
        {hint ? <HelpTip align="left">{hint}</HelpTip> : null}
      </span>
      {children}
    </section>
  );
}

/** The detail for a selected user: an identity header carrying a compact overview strip (memories /
 *  sessions / top model) beside the name, then full-width admin access controls — projects, allowed
 *  models, and the effective tool set (whose plugin tools toggle on/off per user). */
export function UserDetailPane({ user, projects, globalExecs, customModels }: {
  user: OrcaUser;
  projects: Project[];
  globalExecs: string[];
  customModels: { label: string; exec: string }[];
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="rounded-lg border border-border bg-surface p-5" style={{ boxShadow: 'var(--shadow-card)' }}>
      <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border pb-4">
        <Avatar user={user} size={52} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-text">{user.name || user.username}</span>
            {user.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
          </span>
          <span className="truncate font-mono text-xs text-text-muted">@{user.username} · {localDateTime(user.created_at, locale, false)}</span>
        </div>
        {/* Overview stats sit inline beside the identity, pushed to the right on wide layouts. */}
        <div className="ml-auto"><UserStatsInline userId={user.id} /></div>
      </header>

      <div className="flex flex-col gap-5">
        <Block icon={FolderGit2} title={t.users.projects}><ProjectChips userId={user.id} projects={projects} /></Block>
        <Block icon={Cpu} title={t.users.allowedModels}><ModelChips user={user} globalExecs={globalExecs} custom={customModels} /></Block>
        <Block icon={Wrench} title={t.users.tools} hint={t.users.toolsHint}><ToolPills userId={user.id} /></Block>
      </div>
    </div>
  );
}
