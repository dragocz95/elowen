'use client';
import { X } from 'lucide-react';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';

/** Right-side drawer (the same detail-rail pattern the per-model compaction thresholds use) for the
 *  per-project model pins.
 *
 *  These pins are WRITTEN IMPLICITLY: switching the model inside a Git project remembers it for that
 *  project, and the pin then outranks the personal default for every later conversation there. Nothing
 *  ever showed them, so a user could be running a model they never knowingly chose. The drawer is
 *  deliberately not an editor — repointing a project is what the chat picker already does at the point
 *  of use, and a second writer for the same field is how the two would drift. Each row lists the project
 *  root and the model it is pinned to, and clears in one click. */
export function ProjectModelsDrawer({ pins, onClear, onClose }: {
  /** Canonical project root → the provider/model pinned to it. */
  pins: Record<string, { provider: string; model: string }>;
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
            {roots.map((root) => (
              <div key={root} className="flex items-center gap-2.5 py-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                  <ModelIcon name={pins[root]!.model} size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11px] text-muted-foreground" title={root}>{root}</span>
                  <span className="block truncate text-sm font-medium text-foreground">{pins[root]!.model}</span>
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
            ))}
          </div>
        )}
    </WorkspaceDetailRail>
  );
}
