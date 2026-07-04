'use client';
import { useMemo, useState } from 'react';
import {
  Package, User as UserIcon, Wrench, GraduationCap, MessageSquare, ChevronRight,
  Search, LayoutGrid, Database, Clock, Sparkles, ShieldCheck, Code2, type LucideIcon,
} from 'lucide-react';
import { PluginDetail } from './PluginDetail';
import { pluginIcon } from './pluginMeta';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { Input } from '../../components/ui/Input';
import { Segmented } from '../../components/ui/Segmented';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePlugins } from '../../lib/queries';
import { useTogglePlugin } from '../../lib/mutations';
import type { PluginInfo } from '../../lib/types';

/** Marketplace categories, derived from a plugin's `provides`/name (see `categorize`). */
type Category = 'platforms' | 'tools' | 'memory' | 'automation' | 'ui' | 'security' | 'development';

/** Categorize a plugin from what it declares — first match wins, so the checks are ordered by
 *  specificity. A plugin that ships a chat platform is always "Platforms"; after that we key off the
 *  plugin name (memory/cron/security/dev tooling/interface) and fall back to the generic "Tools" pack.
 *  This is a lightweight display heuristic, NOT a capability system. */
function categorize(p: PluginInfo): Category {
  if ((p.provides.platforms?.length ?? 0) > 0) return 'platforms';
  const n = p.name.toLowerCase();
  if (/secur|scan|shield|audit/.test(n)) return 'security';
  if (/memor|embed|recall|vector/.test(n)) return 'memory';
  if (/cron|schedul|automat/.test(n)) return 'automation';
  if (/terminal|file|shell|exec|git|code|build|deploy/.test(n)) return 'development';
  if (/statusline|status|tts|voice|speech|notif|bell|theme|display|ui/.test(n)) return 'ui';
  return 'tools';
}

/** Icon + i18n key per category, used for the filter pills. */
const CATEGORY_META: Record<Category, { icon: LucideIcon; key: 'catPlatforms' | 'catTools' | 'catMemory' | 'catAutomation' | 'catUi' | 'catSecurity' | 'catDevelopment' }> = {
  platforms: { icon: MessageSquare, key: 'catPlatforms' },
  tools: { icon: Wrench, key: 'catTools' },
  memory: { icon: Database, key: 'catMemory' },
  automation: { icon: Clock, key: 'catAutomation' },
  ui: { icon: Sparkles, key: 'catUi' },
  security: { icon: ShieldCheck, key: 'catSecurity' },
  development: { icon: Code2, key: 'catDevelopment' },
};
/** Stable display order of the category pills. */
const CATEGORY_ORDER: Category[] = ['platforms', 'tools', 'memory', 'automation', 'ui', 'security', 'development'];

/** What one plugin contributes, as compact icon badges (tools/skills/platforms with counts). */
function ProvidesBadges({ p }: { p: PluginInfo }) {
  const { t } = useTranslation();
  const parts = [
    { label: t.plugins.tools, count: p.provides.tools?.length ?? 0, Icon: Wrench },
    { label: t.plugins.skills, count: p.provides.skills?.length ?? 0, Icon: GraduationCap },
    { label: t.plugins.platforms, count: p.provides.platforms?.length ?? 0, Icon: MessageSquare },
  ].filter((x) => x.count > 0);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {parts.map(({ label, count, Icon }) => (
        <Badge key={label}><Icon size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />{count} {label}</Badge>
      ))}
    </div>
  );
}

/** One marketplace card: icon chip (live-dot when enabled), name + version + source glyph, a health
 *  badge, the enable toggle and a detail affordance; the provides badges and a one-line description sit
 *  below. Clicking the card body (anywhere but the toggle) opens the plugin's detail view. */
function PluginCard({ p, onDetail, onFlip, busy }: { p: PluginInfo; onDetail: () => void; onFlip: (enabled: boolean) => void; busy: boolean }) {
  const { t, locale } = useTranslation();
  const Icon = pluginIcon(p.name);
  const description = p.i18n?.[locale]?.description ?? p.description;
  const health = p.health ?? 'ok';
  // A health pill only carries meaning for a running plugin (health derives from its recent log ring),
  // so a healthy/disabled plugin shows nothing; errors always surface.
  const showHealth = health === 'error' || p.enabled;
  return (
    <div
      onClick={onDetail}
      className={`card-interactive flex cursor-pointer flex-col gap-2 rounded-xl border px-4 py-3 transition-colors ${p.enabled ? 'border-accent/40' : 'border-border'} bg-surface`}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <div className="flex items-center gap-3">
        <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${p.enabled ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-elevated text-text-muted'}`}>
          <Icon size={17} aria-hidden />
          {p.enabled ? <span className="live-dot absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-surface bg-success" aria-hidden /> : null}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text">{p.name}</span>
            <span className="flex shrink-0 items-center gap-1 font-mono text-tiny text-text-muted" title={p.source === 'bundled' ? t.plugins.bundled : t.plugins.user}>
              {p.source === 'bundled' ? <Package size={11} aria-hidden /> : <UserIcon size={11} aria-hidden />}
              v{p.version}
            </span>
          </div>
        </div>
        {/* Trailing controls stay one shrink-0 cluster so the name block (flex-1 min-w-0) absorbs any
            squeeze first — the badge, toggle and chevron never clip or spill past the card edge. */}
        <div className="flex shrink-0 items-center gap-2">
          {showHealth ? (
            <Badge tone={health === 'error' ? 'danger' : 'success'}>{health === 'error' ? t.plugins.healthError : t.plugins.healthOk}</Badge>
          ) : null}
          {/* Isolate the toggle so flipping enable never bubbles up into the card's open-detail click. */}
          <span onClick={(e) => e.stopPropagation()} className="shrink-0">
            <Toggle checked={p.enabled} onChange={onFlip} label={`${p.name}: ${p.enabled ? t.plugins.disable : t.plugins.enable}`} disabled={busy} />
          </span>
          <IconButton icon={ChevronRight} label={`${p.name}: ${t.common.goTo}`} onClick={onDetail} />
        </div>
      </div>
      <ProvidesBadges p={p} />
      <p className="line-clamp-1 text-xs text-text-muted" title={description}>{description}</p>
    </div>
  );
}

/** Settings → Plugins: a marketplace catalog of every plugin found on disk. A search box + category
 *  pills narrow the grid client-side; each card toggles enable live (the daemon hot-reloads the brain's
 *  plugin registry, no restart) and opens a rich per-plugin detail view. */
export function PluginsSection() {
  const { data, isLoading } = usePlugins();
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');

  const plugins = data ?? [];
  // Category pills: "All" plus only the categories that actually have a plugin, in stable order.
  const categoryOptions = useMemo(() => {
    const present = new Set(plugins.map(categorize));
    return [
      { value: 'all', label: t.plugins.catAll, icon: LayoutGrid },
      ...CATEGORY_ORDER.filter((c) => present.has(c)).map((c) => ({ value: c, label: t.plugins[CATEGORY_META[c].key], icon: CATEGORY_META[c].icon })),
    ];
  }, [plugins, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (category !== 'all' && categorize(p) !== category) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q);
    });
  }, [plugins, query, category]);

  if (detail) return <PluginDetail name={detail} onBack={() => setDetail(null)} />;
  if (isLoading) return <LoadingState variant="cards" />;
  if (plugins.length === 0) return <EmptyState title={t.plugins.empty} />;

  const flip = (p: PluginInfo, enabled: boolean) => toggle.mutate(
    { name: p.name, enabled },
    {
      onSuccess: () => toast(enabled ? t.plugins.enabledToast : t.plugins.disabledToast),
      onError: () => toast(t.plugins.toggleError, 'error'),
    },
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="relative w-full @sm:max-w-xs">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.plugins.searchPlaceholder} className="pl-9" />
        </div>
        <Segmented value={category} onChange={(v) => setCategory(v as Category | 'all')} options={categoryOptions} aria-label={t.plugins.catAll} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={t.plugins.noMatches} description={t.plugins.noMatchesHint} icon={Search} />
      ) : (
        <div className="@container">
          <div className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
            {filtered.map((p) => (
              <PluginCard key={p.name} p={p} busy={toggle.isPending} onFlip={(enabled) => flip(p, enabled)} onDetail={() => setDetail(p.name)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
