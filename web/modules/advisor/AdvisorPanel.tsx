'use client';
import { useRef, useState } from 'react';
import { Bot, X, Plus, PanelLeft, PanelRight } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { AdvisorPane } from './AdvisorPane';
import { SessionPicker } from './SessionPicker';
import type { UseDockState } from '../../lib/useDockState';

const MIN_WEIGHT = 0.12;

/** The docked advisor panel: a full-height side column (left or right) holding a vertical stack of
 *  terminal panes — the user's advisor plus any added live sessions — with a draggable width divider
 *  on its inner edge and draggable dividers between stacked panes. */
export function AdvisorPanel({ dock }: { dock: UseDockState }) {
  const { t } = useTranslation();
  const { state, setOpen, setSide, setWidth, setSizes, addSessionPane, removePane } = dock;
  const stackRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Width drag: on the right the panel grows as the divider moves left (negative dx), so the sign
  // flips by side.
  const onWidthDelta = (dx: number) => setWidth(state.width + (state.side === 'right' ? -dx : dx));

  // Vertical drag between pane i and i+1: convert the pixel delta to a flex-weight shift relative to
  // the stack height and move it from the lower pane to the upper one (dragging down grows pane i).
  const onSplitDelta = (i: number, dy: number) => {
    const h = stackRef.current?.clientHeight ?? 0;
    if (h <= 0) return;
    const total = state.sizes.reduce((a, b) => a + b, 0);
    const shift = (dy / h) * total;
    const next = [...state.sizes];
    const a = next[i]! + shift;
    const b = next[i + 1]! - shift;
    if (a < MIN_WEIGHT * total || b < MIN_WEIGHT * total) return; // keep both panes usable
    next[i] = a;
    next[i + 1] = b;
    setSizes(next);
  };

  const excluded = state.panes.filter((p) => p.kind === 'session').map((p) => p.name!);
  const widthHandle = <ResizeHandle orientation="vertical" onDelta={onWidthDelta} className="h-full" />;

  const column = (
    <div
      className="flex h-full shrink-0 flex-col overflow-hidden border-border bg-surface"
      style={{ width: `min(${state.width}px, 100vw)` }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot size={16} className="text-accent" aria-hidden />
        <span className="text-sm font-semibold">{t.advisor.title}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setSide(state.side === 'right' ? 'left' : 'right')}
          aria-label={state.side === 'right' ? t.advisor.dockLeft : t.advisor.dockRight}
          title={state.side === 'right' ? t.advisor.dockLeft : t.advisor.dockRight}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          {state.side === 'right' ? <PanelLeft size={16} aria-hidden /> : <PanelRight size={16} aria-hidden />}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label={t.advisor.addPane}
            title={t.advisor.addPane}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <Plus size={16} aria-hidden />
          </button>
          <SessionPicker
            open={pickerOpen}
            exclude={excluded}
            onPick={(name) => addSessionPane(name)}
            onClose={() => setPickerOpen(false)}
          />
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t.advisor.close}
          title={t.advisor.close}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      <div ref={stackRef} className="flex min-h-0 flex-1 flex-col">
        {state.panes.map((pane, i) => (
          <div key={pane.id} className="flex min-h-0 flex-col" style={{ flexGrow: state.sizes[i] ?? 1, flexBasis: 0 }}>
            <div className="min-h-0 flex-1">
              <AdvisorPane pane={pane} onRemove={pane.kind === 'session' ? () => removePane(pane.id) : undefined} />
            </div>
            {i < state.panes.length - 1 && (
              <ResizeHandle orientation="horizontal" onDelta={(dy) => onSplitDelta(i, dy)} className="w-full" />
            )}
          </div>
        ))}
      </div>
    </div>
  );

  // The width divider sits on the panel's inner edge: left of the column when docked right, right of it
  // when docked left.
  return state.side === 'right'
    ? <>{widthHandle}{column}</>
    : <>{column}{widthHandle}</>;
}
