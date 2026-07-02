'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ModelIcon } from './ModelIcon';
import { PROVIDERS, providerMeta } from '../../modules/settings/providers';
import { execProvider, execModel, type ProviderId } from '../../lib/modelProvider';
import { useBrainModels, useConfig } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

interface Model { label: string; exec: string }

/** Two-step executor picker: pick the provider (Claude Code / OpenCode / Codex / Kilo / Orca AI),
 *  then one of ITS models — so it is always clear which engine actually runs the work. Orca AI models
 *  come live from the brain catalog (globally allowed ones), CLI models from the passed allow-list.
 *  An empty `value` means "Default". */
export function ExecutorPicker({ value, onChange, models, defaultLabel, allowDefault = true }: {
  value: string;
  onChange: (exec: string) => void;
  models: Model[];
  /** Label for the empty-value pill. Only rendered when `allowDefault` (the default). */
  defaultLabel?: string;
  /** Kept for call-site compatibility; the grouped picker no longer collapses. */
  moreLabel?: string;
  limit?: number;
  /** Whether to offer the empty "default" pill. Off for fields that must resolve to a concrete model. */
  allowDefault?: boolean;
}) {
  const { t } = useTranslation();
  const config = useConfig();
  const brain = useBrainModels();

  // Orca AI models: the live catalog, bounded by the global allow-list (same rule the CLI models
  // already arrive filtered by). Non-admins get a server-side-filtered catalog on top.
  const allowed = config.data?.allowedExecs;
  const orcaModels: Model[] = (brain.data ?? [])
    .filter((m) => !allowed || allowed.includes(m.exec))
    .map((m) => ({ label: m.model, exec: m.exec }));

  const byProvider = new Map<ProviderId, Model[]>();
  for (const m of [...models].sort((a, b) => a.label.localeCompare(b.label))) {
    const p = execProvider(m.exec);
    byProvider.set(p, [...(byProvider.get(p) ?? []), m]);
  }
  if (orcaModels.length > 0) byProvider.set('orca', orcaModels);

  // Only providers that actually have models are offered; the selection's provider drives the open tab.
  const groups = PROVIDERS.filter((p) => (byProvider.get(p.id as ProviderId) ?? []).length > 0);
  const valueProvider = value ? execProvider(value) : null;
  const [openProvider, setOpenProvider] = useState<ProviderId | null>(null);
  const active = openProvider ?? valueProvider ?? (allowDefault && value === '' ? null : (groups[0]?.id as ProviderId | undefined) ?? null);
  const activeModels = active ? (byProvider.get(active) ?? []) : [];

  const pill = (activePill: boolean, key: string, onClick: () => void, children: React.ReactNode) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      aria-pressed={activePill}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${activePill ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      {children}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {/* Step 1: the engine. Brand logo + name; the tab with the current selection carries a dot.
          "Default" is a tab of the same shape so the row reads as one uniform strip. */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t.tasks.pickProvider}>
        {allowDefault ? (
          <button
            type="button"
            role="tab"
            aria-selected={value === ''}
            onClick={() => { onChange(''); setOpenProvider(null); }}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${value === '' ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border text-text-muted hover:bg-elevated hover:text-text'}`}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            <Sparkles size={14} aria-hidden />
            {defaultLabel}
          </button>
        ) : null}
        {groups.map((p) => {
          const meta = providerMeta(p.id)!;
          const isOpen = active === p.id;
          const holdsSelection = valueProvider === p.id && value !== '';
          return (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={isOpen}
              onClick={() => setOpenProvider(p.id as ProviderId)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${isOpen ? 'border-border-strong bg-elevated text-text' : 'border-border text-text-muted hover:bg-elevated hover:text-text'}`}
              style={{ transitionDuration: 'var(--motion-fast)' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={meta.icon} alt="" width={14} height={14} style={{ objectFit: 'contain' }} className={meta.embedded ? 'logo-adaptive' : undefined} aria-hidden />
              {meta.label}
              {holdsSelection ? <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {/* Step 2: that provider's models. */}
      {activeModels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 border-l-2 border-border pl-2.5">
          {activeModels.map((m) => pill(value === m.exec, m.exec, () => onChange(m.exec), (
            <><ModelIcon name={active === 'orca' ? execModel(m.exec).slice(execModel(m.exec).indexOf('/') + 1) : m.exec} size={15} />{m.label}</>
          )))}
        </div>
      ) : null}
    </div>
  );
}
