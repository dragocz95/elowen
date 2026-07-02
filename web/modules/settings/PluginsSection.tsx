'use client';
import { Puzzle, Package, User as UserIcon } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePlugins } from '../../lib/queries';
import { useTogglePlugin } from '../../lib/mutations';
import type { PluginInfo } from '../../lib/types';

/** What one plugin contributes, as compact badges (tools/skills/platforms counts). */
function ProvidesBadges({ p }: { p: PluginInfo }) {
  const { t } = useTranslation();
  const parts: { label: string; count: number }[] = [
    { label: t.plugins.tools, count: p.provides.tools?.length ?? 0 },
    { label: t.plugins.skills, count: p.provides.skills?.length ?? 0 },
    { label: t.plugins.platforms, count: p.provides.platforms?.length ?? 0 },
  ].filter((x) => x.count > 0);
  if (parts.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {parts.map((x) => <Badge key={x.label}>{x.label}</Badge>)}
    </span>
  );
}

/** Settings → Plugins: every plugin found on disk, with an on/off toggle. Enabling applies live —
 *  the daemon hot-reloads the brain's plugin registry, no restart needed. */
export function PluginsSection() {
  const { data, isLoading } = usePlugins();
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t } = useTranslation();

  if (isLoading) return <LoadingState />;
  if (!data || data.length === 0) return <EmptyState title={t.plugins.empty} />;

  const flip = (p: PluginInfo, enabled: boolean) => toggle.mutate(
    { name: p.name, enabled },
    {
      onSuccess: () => toast(enabled ? t.plugins.enabledToast : t.plugins.disabledToast),
      onError: () => toast(t.plugins.toggleError, 'error'),
    },
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">{t.plugins.intro}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((p) => (
          <div key={p.name} className={`flex flex-col gap-3 rounded-lg border p-4 transition-colors ${p.enabled ? 'border-accent/40 bg-accent/5' : 'border-border bg-surface'}`} style={{ transitionDuration: 'var(--motion-fast)' }}>
            <div className="flex items-start gap-3">
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${p.enabled ? 'border-accent/40 bg-accent/10 text-accent' : 'border-border bg-elevated text-text-muted'}`}>
                <Puzzle size={20} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-text">{p.name}</span>
                  <span className="font-mono text-tiny text-text-muted">v{p.version}</span>
                </span>
                <span className="flex items-center gap-1 text-tiny text-text-muted">
                  {p.source === 'bundled' ? <Package size={11} aria-hidden /> : <UserIcon size={11} aria-hidden />}
                  {p.source === 'bundled' ? t.plugins.bundled : t.plugins.user}
                </span>
              </div>
              <Toggle checked={p.enabled} onChange={(v) => flip(p, v)} label={`${p.name}: ${p.enabled ? t.plugins.disable : t.plugins.enable}`} disabled={toggle.isPending} />
            </div>
            <p className="text-xs leading-relaxed text-text-muted">{p.description}</p>
            <ProvidesBadges p={p} />
          </div>
        ))}
      </div>
      <p className="text-xs text-text-muted">{t.plugins.applyHint}</p>
    </div>
  );
}
