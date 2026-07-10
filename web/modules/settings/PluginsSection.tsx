'use client';
import { useMemo, useState } from 'react';
import {
  Package, User as UserIcon, Wrench, GraduationCap, MessageSquare,
  Search, LayoutGrid, Database, Clock, Sparkles, ShieldCheck, Code2, Download, Trash2,
  ArrowUpCircle, Eye, Power, RotateCcw, MoreHorizontal, type LucideIcon,
} from 'lucide-react';
import { PluginDetail } from './PluginDetail';
import { PluginIcon } from './PluginIcon';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { Input } from '../../components/ui/Input';
import { Segmented } from '../../components/ui/Segmented';
import { Toggle } from '../../components/ui/Toggle';
import { HelpTip } from '../../components/ui/HelpTip';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ContextMenu, DIVIDER, type ContextMenuState, type MenuEntry } from '../../components/ui/ContextMenu';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePlugins, useMarketplace } from '../../lib/queries';
import { useTogglePlugin, useInstallPlugin, useUpdatePlugin, useUninstallPlugin, useRestorePlugin } from '../../lib/mutations';
import type { PluginInfo, MarketplaceEntry } from '../../lib/types';
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { PageFrame } from '../../components/ui/PageFrame';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';

/** Marketplace categories, derived from a plugin's `provides`/name (see `categorize`). */
type Category = 'platforms' | 'tools' | 'memory' | 'automation' | 'ui' | 'security' | 'development';

/** Categorize a plugin from what it declares — first match wins, so the checks are ordered by
 *  specificity. A plugin that ships a chat platform is always "Platforms"; after that we key off the
 *  plugin name (memory/cron/security/dev tooling/interface) and fall back to the generic "Tools" pack.
 *  This is a lightweight display heuristic, NOT a capability system. */
function categorize(name: string, platformCount: number): Category {
  if (platformCount > 0) return 'platforms';
  const n = name.toLowerCase();
  if (/secur|scan|shield|audit/.test(n)) return 'security';
  if (/mem0|memor|embed|recall|vector/.test(n)) return 'memory';
  if (/cron|schedul|automat|todo|task/.test(n)) return 'automation';
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

/** What one plugin contributes, as compact icon badges (tools/skills/platforms with counts). Works off
 *  the array-valued `provides` of an installed plugin or the count-valued `provides` of a catalog entry. */
function ProvidesBadges({ counts }: { counts: { tools: number; skills: number; platforms: number } }) {
  const { t } = useTranslation();
  const parts = [
    { label: t.plugins.tools, count: counts.tools, Icon: Wrench },
    { label: t.plugins.skills, count: counts.skills, Icon: GraduationCap },
    { label: t.plugins.platforms, count: counts.platforms, Icon: MessageSquare },
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

/** One thin installed-plugin row: semantic icon, identity + description, compact capabilities, then
 *  health/toggle/actions. Rows share one divided surface instead of repeating card chrome. */
function PluginCard({ p, updatable, onDetail, onFlip, onUpdate, onUninstall, onContextMenu, busy }: {
  p: PluginInfo; updatable: boolean; onDetail: () => void; onFlip: (enabled: boolean) => void;
  onUpdate: () => void; onUninstall: () => void; onContextMenu: (e: React.MouseEvent) => void; busy: boolean;
}) {
  const { t, locale } = useTranslation();
  const description = p.i18n?.[locale]?.description ?? p.description;
  const health = p.health ?? 'ok';
  // A health pill only carries meaning for a running plugin (health derives from its recent log ring),
  // so a healthy/disabled plugin shows nothing; errors always surface.
  const showHealth = health === 'error' || p.enabled;
  return (
    <EntityRow
      role="presentation"
      busy={busy}
      onContextMenu={onContextMenu}
      className="group @container"
      style={{ transitionDuration: 'var(--motion-fast)' }}
    >
      <div className="flex min-w-0 items-center gap-3 px-1 @sm:px-2">
        <button
          type="button"
          onClick={onDetail}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <span className="relative shrink-0">
            <PluginIcon name={p.name} hasIcon={p.hasIcon} size={38} />
            {p.enabled ? <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-bg bg-success" aria-hidden /> : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-text transition-colors group-hover:text-accent">{p.name}</span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[9px] text-text-muted" title={p.source === 'bundled' ? t.plugins.bundled : t.plugins.user}>
                {p.source === 'bundled' ? <Package size={10} aria-hidden /> : <UserIcon size={10} aria-hidden />}v{p.version}
              </span>
              {updatable ? <span className="hidden text-[10px] font-medium text-accent @sm:inline">{t.plugins.updateAvailable}</span> : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-text-muted" title={description}>{description}</span>
          </span>
        </button>
        <div className="hidden max-w-[18rem] shrink-0 items-center gap-2 @3xl:flex">
          <ProvidesBadges counts={{ tools: p.provides.tools?.length ?? 0, skills: p.provides.skills?.length ?? 0, platforms: p.provides.platforms?.length ?? 0 }} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showHealth ? (
            <Badge tone={health === 'error' ? 'danger' : 'success'}>{health === 'error' ? t.plugins.healthError : t.plugins.healthOk}</Badge>
          ) : null}
          <Toggle checked={p.enabled} onChange={onFlip} label={`${p.name}: ${p.enabled ? t.plugins.disable : t.plugins.enable}`} disabled={busy} />
          <ActionMenu
            label={`${p.name}: ${t.common.actions}`}
            trigger={<MoreHorizontal size={16} aria-hidden />}
            triggerClassName="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            items={[
              { label: t.plugins.detail, icon: Eye, onSelect: onDetail },
              ...(updatable ? [{ label: t.plugins.update, icon: ArrowUpCircle, onSelect: onUpdate }] : []),
              { label: p.source === 'bundled' ? t.plugins.remove : t.plugins.uninstall, icon: Trash2, tone: 'danger' as const, onSelect: onUninstall },
            ]}
          />
        </div>
      </div>
    </EntityRow>
  );
}

/** One available-plugin card (not yet installed): a muted icon chip, name + version + author, provides
 *  badges, a one-line description, and an Install button that downloads it from the registry and enables it. */
function MarketplaceCard({ e, onInstall, busy }: { e: MarketplaceEntry; onInstall: () => void; busy: boolean }) {
  const { t } = useTranslation();
  return (
    <EntityRow role="presentation" busy={busy} interactive={false} className="@container">
      <div className="flex min-w-0 items-center gap-3 px-1 @sm:px-2">
        <PluginIcon name={e.name} size={38} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text">{e.name}</span>
            <span className="shrink-0 font-mono text-tiny text-text-muted">v{e.version}</span>
          </div>
          <p className="truncate text-xs text-text-muted" title={e.description}>{e.description}</p>
        </div>
        <Button variant="default" icon={Download} onClick={onInstall} disabled={busy} className="shrink-0">
          {busy ? t.plugins.installing : t.plugins.install}
        </Button>
      </div>
    </EntityRow>
  );
}

/** One soft-removed bundled plugin (shown at the top of the Available view): a muted icon chip, name +
 *  version, description, and a Restore button that brings it back (disabled) into the installed list. */
function RemovedCard({ p, onRestore, busy }: { p: PluginInfo; onRestore: () => void; busy: boolean }) {
  const { t, locale } = useTranslation();
  const description = p.i18n?.[locale]?.description ?? p.description;
  return (
    <EntityRow role="presentation" busy={busy} interactive={false} className="@container">
      <div className="flex min-w-0 items-center gap-3 px-1 @sm:px-2">
        <PluginIcon name={p.name} hasIcon={p.hasIcon} size={38} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text">{p.name}</span>
            <span className="shrink-0 font-mono text-tiny text-text-muted">v{p.version}</span>
          </div>
          <p className="truncate text-xs text-text-muted" title={description}>{description}</p>
        </div>
        <Button variant="default" icon={RotateCcw} onClick={onRestore} disabled={busy} className="shrink-0">
          {t.plugins.restore}
        </Button>
      </div>
    </EntityRow>
  );
}

/** Settings → Plugins: a marketplace with two views. **Installed** lists every plugin on disk (bundled +
 *  downloaded), each toggling enable live and opening a rich detail view; user plugins can be updated (when
 *  the registry has a newer version) or uninstalled. **Available** browses the curated GitHub registry for
 *  plugins not yet installed and installs them with one click. A search box + category pills narrow both. */
export function PluginsSection() {
  const { data, isLoading } = usePlugins();
  const marketplace = useMarketplace();
  const toggle = useTogglePlugin();
  const install = useInstallPlugin();
  const update = useUpdatePlugin();
  const uninstall = useUninstallPlugin();
  const restore = useRestorePlugin();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<string | null>(null);
  const [view, setView] = useState<'installed' | 'available'>('installed');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category | 'all'>('all');
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const plugins = useMemo(() => data ?? [], [data]);
  // Soft-removed bundled plugins are hidden from the Installed list and offered for restore at the top
  // of the Available view; everything else is a normal installed plugin.
  const installed = useMemo(() => plugins.filter((p) => !p.removed), [plugins]);
  const removedBundled = useMemo(() => plugins.filter((p) => p.removed), [plugins]);
  // The catalog powers the Available view and, cross-referenced by name, the "update available" hint on
  // installed cards. Names with a newer version in the registry.
  const updatable = useMemo(
    () => new Set((marketplace.data?.plugins ?? []).filter((e) => e.status === 'updateAvailable').map((e) => e.name)),
    [marketplace.data],
  );
  const available = useMemo(
    () => (marketplace.data?.plugins ?? []).filter((e) => e.status === 'available'),
    [marketplace.data],
  );

  // Category pills: "All" plus only the categories present in the ACTIVE view, in stable order.
  const categoryOptions = useMemo(() => {
    const present = new Set(view === 'installed'
      ? installed.map((p) => categorize(p.name, p.provides.platforms?.length ?? 0))
      : available.map((e) => categorize(e.name, e.provides?.platforms ?? 0)));
    return [
      { value: 'all', label: t.plugins.catAll, icon: LayoutGrid },
      ...CATEGORY_ORDER.filter((c) => present.has(c)).map((c) => ({ value: c, label: t.plugins[CATEGORY_META[c].key], icon: CATEGORY_META[c].icon })),
    ];
  }, [installed, available, view, t]);

  const filteredInstalled = useMemo(() => {
    const q = query.trim().toLowerCase();
    return installed.filter((p) => {
      if (category !== 'all' && categorize(p.name, p.provides.platforms?.length ?? 0) !== category) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q);
    });
  }, [installed, query, category]);

  const filteredAvailable = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter((e) => {
      if (category !== 'all' && categorize(e.name, e.provides?.platforms ?? 0) !== category) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q);
    });
  }, [available, query, category]);

  if (detail) return <PageFrame width="fluid"><PluginDetail name={detail} onBack={() => setDetail(null)} /></PageFrame>;
  if (isLoading) return <PageFrame width="fluid"><LoadingState variant="list" /></PageFrame>;

  const flip = (p: PluginInfo, enabled: boolean) => toggle.mutate(
    { name: p.name, enabled },
    { onSuccess: () => toast(enabled ? t.plugins.enabledToast : t.plugins.disabledToast), onError: () => toast(t.plugins.toggleError, 'error') },
  );
  const doInstall = (name: string) => {
    setPending(name);
    install.mutate({ name }, {
      onSuccess: () => { toast(t.plugins.installedToast); setView('installed'); },
      onError: () => toast(t.plugins.installError, 'error'),
      onSettled: () => setPending(null),
    });
  };
  const doUpdate = (name: string) => {
    setPending(name);
    update.mutate(name, {
      onSuccess: () => toast(t.plugins.updatedToast),
      onError: () => toast(t.plugins.updateError, 'error'),
      onSettled: () => setPending(null),
    });
  };
  const doUninstall = (name: string) => {
    const bundled = plugins.find((x) => x.name === name)?.source === 'bundled';
    setConfirmRemove(null);
    setPending(name);
    uninstall.mutate(name, {
      onSuccess: () => toast(bundled ? t.plugins.removedToast : t.plugins.uninstallToast),
      onError: () => toast(bundled ? t.plugins.removedError : t.plugins.uninstallError, 'error'),
      onSettled: () => setPending(null),
    });
  };
  const doRestore = (name: string) => {
    setPending(name);
    restore.mutate(name, {
      onSuccess: () => toast(t.plugins.restoredToast),
      onError: () => toast(t.plugins.restoreError, 'error'),
      onSettled: () => setPending(null),
    });
  };
  // Right-click a plugin card → management actions. Remove is offered for every plugin (a user plugin
  // uninstalls; a bundled one soft-removes, restorable); Update shows only when the registry has a newer version.
  const openMenu = (e: React.MouseEvent, p: PluginInfo) => {
    e.preventDefault();
    const items: MenuEntry[] = [
      { label: t.plugins.detail, icon: Eye, onClick: () => setDetail(p.name) },
      { label: p.enabled ? t.plugins.disable : t.plugins.enable, icon: Power, onClick: () => flip(p, !p.enabled) },
    ];
    if (updatable.has(p.name)) items.push({ label: t.plugins.update, icon: ArrowUpCircle, onClick: () => doUpdate(p.name) });
    items.push(DIVIDER);
    items.push({ label: p.source === 'bundled' ? t.plugins.remove : t.plugins.uninstall, icon: Trash2, danger: true, onClick: () => setConfirmRemove(p.name) });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const viewOptions = [
    { value: 'installed', label: t.plugins.tabInstalled, icon: Package },
    { value: 'available', label: t.plugins.tabAvailable, icon: Download },
  ];
  // Whether the plugin pending removal is bundled (soft-remove) vs user (hard uninstall) — drives the confirm copy.
  const removeIsBundled = plugins.find((p) => p.name === confirmRemove)?.source === 'bundled';

  return (
    <PageFrame width="fluid">
      <div className="flex items-center gap-2">
        <Segmented variant="line" value={view} onChange={(v) => { setView(v as 'installed' | 'available'); setCategory('all'); }} options={viewOptions} aria-label={t.plugins.tabInstalled} />
        <HelpTip>{t.help.pluginsManage}</HelpTip>
      </div>

      <div className="flex flex-col gap-3">
        <div className="relative w-full @sm:max-w-xs">
          <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.plugins.searchPlaceholder} className="pl-9" />
        </div>
        <Segmented variant="line" value={category} onChange={(v) => setCategory(v as Category | 'all')} options={categoryOptions} aria-label={t.plugins.catAll} />
      </div>

      {view === 'installed' ? (
        installed.length === 0 ? (
          <EmptyState title={t.plugins.empty} />
        ) : filteredInstalled.length === 0 ? (
          <EmptyState title={t.plugins.noMatches} description={t.plugins.noMatchesHint} icon={Search} />
        ) : (
          <EntityList className="@container" data-testid="installed-plugins-list">
            <MotionPresence>
              {filteredInstalled.map((p) => (
                <MotionLayoutItem key={p.name} layoutId={`installed-plugin-${p.name}`} role="listitem">
                  <PluginCard
                    p={p} updatable={updatable.has(p.name)}
                    busy={pending === p.name || (toggle.isPending && toggle.variables?.name === p.name)}
                    onFlip={(enabled) => flip(p, enabled)} onDetail={() => setDetail(p.name)}
                    onUpdate={() => doUpdate(p.name)} onUninstall={() => setConfirmRemove(p.name)}
                    onContextMenu={(e) => openMenu(e, p)}
                  />
                </MotionLayoutItem>
              ))}
            </MotionPresence>
          </EntityList>
        )
      ) : (
        <div className="flex flex-col gap-5">
          {/* Soft-removed bundled plugins live at the top of Available — where you'd look to add one back. */}
          {removedBundled.length > 0 ? (
            <div className="flex flex-col gap-3">
              <span className="text-sm font-medium text-text">{t.plugins.removedSection}</span>
              <EntityList className="@container" data-testid="removed-plugins-list">
                <MotionPresence>
                  {removedBundled.map((p) => (
                    <MotionLayoutItem key={p.name} layoutId={`removed-plugin-${p.name}`} role="listitem">
                      <RemovedCard p={p} busy={pending === p.name} onRestore={() => doRestore(p.name)} />
                    </MotionLayoutItem>
                  ))}
                </MotionPresence>
              </EntityList>
            </div>
          ) : null}
          {marketplace.isLoading ? (
            <LoadingState variant="cards" />
          ) : marketplace.data?.registryError ? (
            <EmptyState title={t.plugins.marketplaceError} description={marketplace.data.registryError} icon={Download} />
          ) : available.length === 0 ? (
            removedBundled.length === 0 ? <EmptyState title={t.plugins.marketplaceEmpty} icon={Download} /> : null
          ) : filteredAvailable.length === 0 ? (
            <EmptyState title={t.plugins.noMatches} description={t.plugins.noMatchesHint} icon={Search} />
          ) : (
            <EntityList className="@container" data-testid="available-plugins-list">
              <MotionPresence>
                {filteredAvailable.map((e) => (
                  <MotionLayoutItem key={e.name} layoutId={`available-plugin-${e.name}`} role="listitem">
                    <MarketplaceCard e={e} busy={pending === e.name} onInstall={() => doInstall(e.name)} />
                  </MotionLayoutItem>
                ))}
              </MotionPresence>
            </EntityList>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove !== null}
        // A bundled plugin soft-removes (restorable); a user plugin uninstalls (files deleted) — the
        // wording/label reflects which, so the consequence is clear before confirming.
        title={removeIsBundled ? t.plugins.remove : t.plugins.uninstall}
        description={(removeIsBundled ? t.plugins.removeConfirm : t.plugins.uninstallConfirm).replace('{name}', confirmRemove ?? '')}
        confirmLabel={removeIsBundled ? t.plugins.remove : t.plugins.uninstall}
        onConfirm={() => confirmRemove && doUninstall(confirmRemove)}
        onClose={() => setConfirmRemove(null)}
      />
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </PageFrame>
  );
}
