'use client';
import { RotateCcw } from 'lucide-react';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Slider } from '../../components/ui/Slider';
import { useTranslation } from '../../lib/i18n';
import { formatTokens } from '../../lib/format';
import type { BrainModelOption } from '../../lib/types';

/** Right-side drawer (the users/ detail-rail pattern) for per-model auto-compact thresholds. Each model
 *  has a different context window, so the same percentage lands at a different absolute size — this lets a
 *  user compact a small-context model earlier than a large one. A row without an override shows the global
 *  default (greyed) and its slider sits at it; dragging sets an override, the ↺ button clears it. Overrides
 *  are keyed `provider/model` — the same convention the daemon resolves and the context-window map uses. */
export function CompactThresholdsDrawer({ models, thresholds, defaultPct, onChange, onClose }: {
  models: BrainModelOption[];
  thresholds: Record<string, number>;
  /** The global threshold a model inherits when it has no override. */
  defaultPct: number;
  onChange: (key: string, pct: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WorkspaceDetailRail label={t.cli.compactByModelTitle} closeLabel={t.common.close} onClose={onClose}>
      <p className="mb-4 text-xs text-text-muted">{t.help.cliCompactByModel}</p>
      <div className="flex flex-col divide-y divide-border">
        {models.map((m) => {
          const key = `${m.provider}/${m.model}`;
          const override = thresholds[key];
          const pct = override ?? defaultPct;
          return (
            <div key={m.exec} className="flex items-center gap-3 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center text-text-muted"><ModelIcon name={m.model} size={18} /></span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-text">{m.model}</span>
                <span className="block truncate font-mono text-[11px] text-text-muted">{formatTokens(m.contextWindow)} · {m.providerLabel}</span>
              </div>
              <Slider
                value={pct}
                min={30}
                max={95}
                step={5}
                onChange={(v) => onChange(key, v)}
                aria-label={`${t.cli.compactByModelTitle}: ${m.providerLabel} ${m.model}`}
                className="w-24 shrink-0"
              />
              <span className={`w-14 shrink-0 text-right font-mono text-xs tabular-nums ${override != null ? 'text-accent' : 'text-text-muted'}`}>
                {override != null ? `${pct}%` : t.cli.compactByModelDefault}
              </span>
              {override != null ? (
                <button
                  type="button"
                  onClick={() => onChange(key, null)}
                  aria-label={`${t.cli.compactByModelReset}: ${m.providerLabel} ${m.model}`}
                  className="shrink-0 text-text-muted transition-colors hover:text-text"
                >
                  <RotateCcw size={14} aria-hidden />
                </button>
              ) : <span className="w-[14px] shrink-0" aria-hidden />}
            </div>
          );
        })}
      </div>
    </WorkspaceDetailRail>
  );
}
