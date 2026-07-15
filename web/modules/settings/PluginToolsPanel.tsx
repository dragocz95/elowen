'use client';
import { useState, type ReactNode } from 'react';
import { Wrench, Search } from 'lucide-react';
import { SettingsGroup } from './SettingsSurface';
import { Input } from '../../components/ui/Input';
import { MorePill } from '../../components/ui/MorePill';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import type { PluginContributions } from '../../lib/types';
import { namePill } from './pluginDetail.shared';

const PILL_PREVIEW = 4;

/** A wrapping pill row that keeps the UI tidy: shows the first `PILL_PREVIEW` pills and folds the rest
 *  behind a "+N more" toggle. `expandAll` forces the full list open (e.g. while a search filter is active). */
function PillRow({ pills, expandAll = false }: { pills: ReactNode[]; expandAll?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll || expandAll ? pills : pills.slice(0, PILL_PREVIEW);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible}
      {!expandAll && pills.length > PILL_PREVIEW ? (
        <MorePill expanded={showAll} hidden={pills.length - PILL_PREVIEW} onToggle={() => setShowAll((v) => !v)} />
      ) : null}
    </div>
  );
}

/** Tools section body: the plugin's live tools / skills / platforms, grouped and searchable by name. */
function ContributionsList({ contributions }: { contributions?: PluginContributions }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = [
    { key: 'tools' as const, label: t.pluginDetail.tools },
    { key: 'skills' as const, label: t.pluginDetail.skills },
    { key: 'platforms' as const, label: t.pluginDetail.platforms },
  ];
  const total = (contributions?.tools.length ?? 0) + (contributions?.skills.length ?? 0) + (contributions?.platforms.length ?? 0);
  if (total === 0) return <EmptyState title={t.pluginDetail.toolsEmpty} icon={Wrench} />;
  const filtered = groups
    .map((g) => ({ ...g, items: (contributions?.[g.key] ?? []).filter((i) => i.name.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.plugins.searchPlaceholder} className="pl-9" />
      </div>
      {filtered.map((g) => (
        <div key={g.key} className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{g.label}</span>
          <PillRow expandAll={q.length > 0} pills={g.items.map((i) => <span key={i.name} className={namePill}>{i.name}</span>)} />
        </div>
      ))}
    </div>
  );
}

/** Tools panel: the plugin's live tools / skills / platforms as a settings-group card. */
export function PluginToolsPanel({ contributions }: { contributions?: PluginContributions }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup className="plugin-card" icon={Wrench} title={t.pluginDetail.tools} description={t.pluginDetail.toolsHint}>
      <div className="settings-group__panel"><ContributionsList contributions={contributions} /></div>
    </SettingsGroup>
  );
}
