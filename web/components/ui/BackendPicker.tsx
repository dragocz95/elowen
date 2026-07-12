'use client';
import { useState, type ReactNode } from 'react';
import { ModelIcon } from './ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from './ManageSelectionModal';
import { SelectionSummary } from './SelectionSummary';
import { providerMeta } from '../../modules/settings/providers';
import { execProvider, type ProviderId } from '../../lib/modelProvider';
import { useBrainModels, useConfig } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** Engine brand logo for a worker group header/chip (Claude Code / OpenCode / Codex / …). */
function WorkerGroupIcon({ provider }: { provider: ProviderId }) {
  const meta = providerMeta(provider);
  if (!meta) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={meta.icon} alt="" width={14} height={14} style={{ objectFit: 'contain' }} className={meta.embedded ? 'logo-adaptive' : undefined} aria-hidden />
  );
}

/** Per-role reasoning backend picker: a compact summary chip + a Manage modal that reuses the
 *  ExecutorPicker split — a "Workers" group per CLI engine (engine logo on the header, model brand
 *  icon per row) and one group per configured Elowen AI provider (provider brand logo on the header,
 *  OAuth accounts badged). Single-select: a row click replaces the pick. When `allowRelay`, a pinned
 *  "relay" row (empty exec) sits above the groups; an empty value otherwise resolves to relay too.
 *  A saved-but-unknown exec (e.g. a removed preset) stays visible as a pinned, selectable row so a
 *  save can never silently drop it. Keeps the { value, onChange, models, relayLabel, allowRelay }
 *  signature its settings call sites already use. */
export function BackendPicker({ value, onChange, models, relayLabel, allowRelay = true, kind = 'all', title }: {
  value: string;
  onChange: (v: string) => void;
  models: { label: string; exec: string }[];
  relayLabel: string;
  allowRelay?: boolean;
  kind?: 'all' | 'brain';
  title?: string;
}) {
  const { t } = useTranslation();
  const config = useConfig();
  const brain = useBrainModels();
  const [open, setOpen] = useState(false);

  // Elowen AI models gated by the global allow-list (what may run as an executor), grouped by their real
  // provider — same rule as ExecutorPicker's `kind='all'` Elowen AI section.
  const allowed = config.data?.allowedExecs;
  const brainList = (brain.data ?? []).filter((m) => kind === 'brain' || !allowed || allowed.includes(m.exec));

  // Worker CLI models (from the preset catalog), grouped by engine; elowen execs live in the brain
  // section, never as workers — mirrors ExecutorPicker.
  const workerModels = (kind === 'brain' ? [] : [...models])
    .filter((m) => execProvider(m.exec) !== 'elowen')
    .sort((a, b) => a.label.localeCompare(b.label));

  const known = new Set([...workerModels.map((m) => m.exec), ...brainList.map((m) => m.exec)]);

  const items: ManageSelectionItem[] = [
    ...(allowRelay ? [{ id: '', label: relayLabel, group: '' }] : []),
    // Saved-but-unknown exec: keep it pinned + selectable so a save never drops it.
    ...(value && !known.has(value) ? [{ id: value, label: value, group: '', icon: <ModelIcon name={value} size={14} /> }] : []),
    ...workerModels.map((m) => {
      const prov = execProvider(m.exec);
      return { id: m.exec, label: m.label, group: `w:${prov}`, groupLabel: providerMeta(prov)?.label ?? prov, icon: <ModelIcon name={m.exec} size={14} /> };
    }),
    ...brainList.map((m) => ({
      id: m.exec,
      label: m.model,
      group: `b:${m.provider}`,
      groupLabel: m.providerLabel,
      icon: <ModelIcon name={m.model} size={14} />,
      badges: m.source === 'oauth' ? [{ text: 'OAuth', tone: 'muted' as const }] : undefined,
    })),
  ];

  // Group icons: engine logos for workers, provider brand logos for Elowen AI providers.
  const groupIcons: Record<string, ReactNode> = {};
  for (const prov of new Set(workerModels.map((m) => execProvider(m.exec)))) {
    groupIcons[`w:${prov}`] = <WorkerGroupIcon key={`w:${prov}`} provider={prov} />;
  }
  for (const [provider, label] of new Map(brainList.map((m) => [m.provider, m.providerLabel])).entries()) {
    groupIcons[`b:${provider}`] = <ModelIcon key={`b:${provider}`} name={label} size={14} />;
  }

  // The relay row's id is '' so `value &&` excludes it — an empty value always shows the relay label.
  const selected = value ? items.find((it) => it.id === value) : undefined;
  return (
    <>
      <SelectionSummary
        countText=""
        samples={[value && selected
          ? { label: selected.label, icon: selected.icon }
          : { label: relayLabel }]}
        moreCount={0}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <ManageSelectionModal
        title={title ?? t.settings.executor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        groupIcons={groupIcons}
        emptySelectionHint={relayLabel}
        onSave={(next) => onChange([...next][0] ?? '')}
      />
    </>
  );
}
