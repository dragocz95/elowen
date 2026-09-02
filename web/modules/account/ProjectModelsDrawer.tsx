'use client';
import { X } from 'lucide-react';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { EmptyState } from '../../components/ui/states';
import { interpolate, useTranslation } from '../../lib/i18n';

/** Right-side drawer (the same detail-rail pattern the per-model compaction thresholds use) for the
 *  per-project model pins.
 *
 *  These pins are WRITTEN IMPLICITLY: switching the model inside a Git project remembers it for that
 *  project, and the pin then outranks the personal default for every later conversation there. Nothing
 *  ever showed them, so a user could be running a model they never knowingly chose. The drawer is
 *  deliberately not an editor — repointing a project is what the chat picker already does at the point
 *  of use, and a second writer for the same field is how the two would drift. Each row lists the project
 *  root and the model it is pinned to, and clears in one click. */
export function ProjectModelsDrawer({ pins, offered, fallback, onClear, onClose }: {
  /** Canonical project root → the provider/model pinned to it. */
  pins: Record<string, { provider: string; model: string }>;
  /** Whether a pinned pair is one the catalog still offers. A pin the runtime will not honour — its
   *  provider is gone, or the allow-list no longer permits it — must not be listed as if it were in
   *  force: the spawn chain skips it and starts on {@link fallback} instead. */
  offered: (pin: { provider: string; model: string }) => boolean;
  /** The model a skipped pin actually resolves to (the account's effective primary). */
  fallback: string;
  onClear: (projectRoot: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const roots = Object.keys(pins).sort((a, b) => a.localeCompare(b));
  return (
    <WorkspaceDetailRail label={t.cli.projectModelsTitle} closeLabel={t.common.close} onClose={onClose}>
      <p className="text-xs leading-relaxed text-muted-foreground">{t.help.cliProjectModels}</p>
      {roots.length === 0
        ? <EmptyState title={t.cli.projectModelsEmpty} description={t.help.cliProjectModels} />
        : (
          <div className="flex flex-col divide-y divide-border">
            {roots.map((root) => {
              const pin = pins[root]!;
              const usable = offered(pin);
              return (
                <div key={root} className="flex items-center gap-2.5 py-3.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                    <ModelIcon name={pin.model} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11px] text-muted-foreground" title={root}>{root}</span>
                    <span className="block truncate text-sm font-medium text-foreground">{pin.model}</span>
                    {/* Stored but not honoured — say so, and name what the project runs on instead. */}
                    {!usable ? (
                      <span className="mt-1 flex items-center gap-1.5">
                        <Badge tone="warning">{t.cli.unavailableBadge}</Badge>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {interpolate(t.cli.projectPinFallback, { fallback: fallback || t.cli.unavailableNoFallback })}
                        </span>
                      </span>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => onClear(root)}
                    aria-label={t.cli.projectModelsClear.replace('{project}', root)}
                    className="shrink-0 p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
              );
            })}
          </div>
        )}
    </WorkspaceDetailRail>
  );
}
