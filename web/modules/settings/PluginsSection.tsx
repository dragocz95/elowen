'use client';
import { useState } from 'react';
import { Package, User as UserIcon, Settings2, Wrench, GraduationCap, MessageSquare, Puzzle, type LucideIcon } from 'lucide-react';
import { PluginDetail } from './PluginDetail';
import { pluginIcon } from './pluginMeta';
import { Badge } from '../../components/ui/Badge';
import { IconButton } from '../../components/ui/IconButton';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePlugins } from '../../lib/queries';
import { useTogglePlugin } from '../../lib/mutations';
import type { PluginInfo } from '../../lib/types';

/** What one plugin contributes, as compact icon badges (tools/skills/platforms with counts). */
function ProvidesBadges({ p }: { p: PluginInfo }) {
  const { t } = useTranslation();
  const parts = [
    { label: t.plugins.tools, count: p.provides.tools?.length ?? 0, Icon: Wrench },
    { label: t.plugins.skills, count: p.provides.skills?.length ?? 0, Icon: GraduationCap },
    { label: t.plugins.platforms, count: p.provides.platforms?.length ?? 0, Icon: MessageSquare },
  ].filter((x) => x.count > 0);
  if (parts.length === 0) return null;
  // Own wrapping row, indented past the icon (w-9 + gap-3 = pl-12) so badges never crowd the name.
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-12">
      {parts.map(({ label, count, Icon }) => (
        <Badge key={label}><Icon size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />{count} {label}</Badge>
      ))}
    </div>
  );
}

/** Plugins with a dedicated editor in PluginDetail beyond the manifest config form — they get the
 *  settings gear even when their manifest declares no config fields. */
const CUSTOM_EDITOR_PLUGINS = new Set(['cronjob']);

/** One compact plugin row-card: icon chip (with live-dot when enabled), name + version + provides
 *  badges, the enable toggle and a gear when configurable; the description clamps to one line. */
function PluginCard({ p, onFlip, onDetail, busy }: { p: PluginInfo; onFlip: (enabled: boolean) => void; onDetail: () => void; busy: boolean }) {
  const { t, locale } = useTranslation();
  const Icon = pluginIcon(p.name);
  const description = p.i18n?.[locale]?.description ?? p.description;
  return (
    <div className={`card-interactive flex flex-col gap-1.5 rounded-xl border px-4 py-3 transition-colors ${p.enabled ? 'border-accent/40' : 'border-border'} bg-surface`} style={{ transitionDuration: 'var(--motion-fast)' }}>
      <div className="flex items-center gap-3">
        <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${p.enabled ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-elevated text-text-muted'}`}>
          <Icon size={17} aria-hidden />
          {p.enabled ? <span className="live-dot absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-surface bg-success" aria-hidden /> : null}
        </span>
        {/* Name + version only — the provides badges live on their own wrapping row below, so a
            narrow (mobile) card never squeezes the name down to nothing behind shrink-0 badges. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold text-text">{p.name}</span>
          <span className="flex shrink-0 items-center gap-1 font-mono text-tiny text-text-muted" title={p.source === 'bundled' ? t.plugins.bundled : t.plugins.user}>
            {p.source === 'bundled' ? <Package size={11} aria-hidden /> : <UserIcon size={11} aria-hidden />}
            v{p.version}
          </span>
        </div>
        {p.configurable || CUSTOM_EDITOR_PLUGINS.has(p.name) ? (
          <IconButton icon={Settings2} label={`${p.name}: ${t.plugins.configure}`} onClick={onDetail} />
        ) : null}
        <Toggle checked={p.enabled} onChange={onFlip} label={`${p.name}: ${p.enabled ? t.plugins.disable : t.plugins.enable}`} disabled={busy} />
      </div>
      <ProvidesBadges p={p} />
      <p className="line-clamp-1 text-xs text-text-muted" title={description}>{description}</p>
    </div>
  );
}

/** A small grouping header (icon + title + count), matching the other settings groupings. */
function GroupHeader({ icon: Icon, title, count }: { icon: LucideIcon; title: string; count: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={16} className="text-text-muted" aria-hidden />
      <span className="text-sm font-semibold text-text">{title}</span>
      <span className="font-mono text-tiny text-text-muted">{count}</span>
    </div>
  );
}

/** Settings → Plugins: every plugin found on disk, with an on/off toggle, split into two groups —
 *  platform/infrastructure plugins vs pure tool packs. Enabling applies live — the daemon hot-reloads
 *  the brain's plugin registry, no restart needed. */
export function PluginsSection() {
  const { data, isLoading } = usePlugins();
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [detail, setDetail] = useState<string | null>(null);

  if (detail) return <PluginDetail name={detail} onBack={() => setDetail(null)} />;
  if (isLoading) return <LoadingState />;
  if (!data || data.length === 0) return <EmptyState title={t.plugins.empty} />;

  const flip = (p: PluginInfo, enabled: boolean) => toggle.mutate(
    { name: p.name, enabled },
    {
      onSuccess: () => toast(enabled ? t.plugins.enabledToast : t.plugins.disabledToast),
      onError: () => toast(t.plugins.toggleError, 'error'),
    },
  );

  // Platforms/infrastructure vs pure tool packs: a plugin providing a platform (or nothing tool-shaped
  // at all) is infrastructure; one whose contribution is tools belongs under "Tools".
  const isPlatform = (p: PluginInfo) => (p.provides.platforms?.length ?? 0) > 0 || (p.provides.tools?.length ?? 0) === 0;
  const groups = [
    { key: 'plugins', icon: Puzzle, title: t.plugins.sectionPlugins, items: data.filter(isPlatform) },
    { key: 'tools', icon: Wrench, title: t.plugins.sectionTools, items: data.filter((p) => !isPlatform(p)) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-text-muted">{t.plugins.intro}</p>
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-3">
          <GroupHeader icon={g.icon} title={g.title} count={g.items.length} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {g.items.map((p) => (
              <PluginCard key={p.name} p={p} busy={toggle.isPending} onFlip={(enabled) => flip(p, enabled)} onDetail={() => setDetail(p.name)} />
            ))}
          </div>
        </div>
      ))}
      <p className="text-xs text-text-muted">{t.plugins.applyHint}</p>
    </div>
  );
}
