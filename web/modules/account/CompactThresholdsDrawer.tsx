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
 *  user compact a small-context model earlier than a large one. Each row is two lines so it stays legible on
 *  a phone: the model name, its context window and the current value on top, a full-width slider below. A
 *  row without an override shows the global default (greyed); dragging the slider sets an override, ↺ clears
 *  it. Overrides are keyed `provider/model` — the same convention the daemon resolves and the context-window
 *  map uses. */
export function CompactThresholdsDrawer({ models, thresholds, defaultPct, onChange, onClose }: {
  models: BrainModelOption[];
  /** The global threshold a model inherits when it has no override. */
  defaultPct: number;
  thresholds: Record<string, number>;
  onChange: (key: string, pct: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WorkspaceDetailRail label={t.cli.compactByModelTitle} closeLabel={t.common.close} onClose={onClose}>
      <p className="mb-4 text-xs leading-relaxed text-text-muted">{t.help.cliCompactByModel}</p>
      <div className="flex flex-col divide-y divide-border">
        {models.map((m) => {
          const key = `${m.provider}/${m.model}`;
          const override = thresholds[key];
          const pct = override ?? defaultPct;
          return (
            <div key={m.exec} className="py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted"><ModelIcon name={m.model} size={18} /></span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{m.model}</span>
                  <span className="block truncate font-mono text-[11px] text-text-muted">{formatTokens(m.contextWindow)} · {m.providerLabel}</span>
                </div>
                <span className={`shrink-0 font-mono text-sm tabular-nums ${override != null ? 'text-accent' : 'text-text-muted'}`}>
                  {override != null ? `${pct}%` : t.cli.compactByModelDefault}
                </span>
                {override != null ? (
                  <button
                    type="button"
                    onClick={() => onChange(key, null)}
                    aria-label={`${t.cli.compactByModelReset}: ${m.providerLabel} ${m.model}`}
                    className="shrink-0 p-1 text-text-muted transition-colors hover:text-text"
                  >
                    <RotateCcw size={14} aria-hidden />
                  </button>
                ) : <span className="w-6 shrink-0" aria-hidden />}
              </div>
              <Slider
                value={pct}
                min={30}
                max={95}
                step={5}
                onChange={(v) => onChange(key, v)}
                aria-label={`${t.cli.compactByModelTitle}: ${m.providerLabel} ${m.model}`}
                className="mt-3"
              />
            </div>
          );
        })}
      </div>
    </WorkspaceDetailRail>
  );
}
