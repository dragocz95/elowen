'use client';
import { useRef, useState } from 'react';
import { X, Plus, PanelLeft, PanelRight, PanelTop, PanelBottom, MessageCircle, SquareTerminal } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { Segmented } from '../../components/ui/Segmented';
import { usePersistentState } from '../../lib/usePersistentState';
import { AdvisorPane } from './AdvisorPane';
import { BrainChat } from './BrainChat';
import { SessionPicker } from './SessionPicker';
import type { UseDockState } from '../../lib/useDockState';
import type { DockSide } from '../../lib/useDockState';

const MIN_WEIGHT = 0.12;

/** The docked advisor panel: a full-height side column (left or right) holding a vertical stack of
 *  terminal panes — the user's advisor plus any added live sessions — with a draggable width divider
 *  on its inner edge and draggable dividers between stacked panes. */
export function AdvisorPanel({ dock }: { dock: UseDockState }) {
  const { t } = useTranslation();
  const { state, setOpen, setSide, setWidth, setHeight, setSizes, addSessionPane, removePane, addAdvisorPane } = dock;
  const stackRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  // Chat = the embedded brain (same one `orca chat` talks to); Terminal = the tmux panes. Chat first.
  const [mode, setMode] = usePersistentState<'chat' | 'terminal'>('orca.dock.mode', 'chat', ['chat', 'terminal']);
  const horizontal = state.side === 'left' || state.side === 'right';

  // Width drag: on the right the panel grows as the divider moves left (negative dx), so the sign
  // flips by side. Same logic vertically: a bottom dock grows as the divider moves up (negative dy).
  const onWidthDelta = (dx: number) => setWidth(state.width + (state.side === 'right' ? -dx : dx));
  const onHeightDelta = (dy: number) => setHeight(state.height + (state.side === 'bottom' ? -dy : dy));

  const SIDE_OPTIONS: { side: DockSide; Icon: typeof PanelLeft; label: string }[] = [
    { side: 'left', Icon: PanelLeft, label: t.advisor.dockLeft },
    { side: 'right', Icon: PanelRight, label: t.advisor.dockRight },
    { side: 'top', Icon: PanelTop, label: t.advisor.dockTop },
    { side: 'bottom', Icon: PanelBottom, label: t.advisor.dockBottom },
  ];
  const ActiveSideIcon = SIDE_OPTIONS.find((o) => o.side === state.side)!.Icon;

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
      className={`flex shrink-0 flex-col overflow-hidden border-border bg-surface ${horizontal ? 'h-full' : 'w-full'}`}
      style={horizontal ? { width: `min(${state.width}px, 100vw)` } : { height: `min(${state.height}px, 85vh)` }}
    >
      {/* Thin global toolbar for the whole dock (it may hold several panes), so it carries no pane
          title — each pane labels itself below. Controls are right-aligned. */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Segmented
          aria-label={t.brainChat.modeNav}
          size="sm"
          options={[
            { value: 'chat', label: t.brainChat.modeChat, icon: MessageCircle },
            { value: 'terminal', label: t.brainChat.modeTerminal, icon: SquareTerminal },
          ]}
          value={mode}
          onChange={(v) => setMode(v as 'chat' | 'terminal')}
        />
        <div className="flex-1" />
        <div className="relative">
          <button
            type="button"
            onClick={() => setSideMenuOpen((v) => !v)}
            aria-label={t.advisor.dockPosition}
            title={t.advisor.dockPosition}
            aria-expanded={sideMenuOpen}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
          >
            <ActiveSideIcon size={16} aria-hidden />
          </button>
          {sideMenuOpen ? (
            <div className={`absolute z-30 flex gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-lg ${state.side === 'top' ? 'top-full mt-1' : 'bottom-auto top-8'} right-0`}>
              {SIDE_OPTIONS.map(({ side, Icon, label }) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => { setSide(side); setSideMenuOpen(false); }}
                  aria-label={label}
                  title={label}
                  className={`flex h-7 w-7 items-center justify-center rounded ${side === state.side ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'}`}
                >
                  <Icon size={15} aria-hidden />
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="relative" style={mode === 'chat' ? { display: 'none' } : undefined}>
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
            showAdvisor={!state.panes.some((p) => p.kind === 'advisor')}
            onAddAdvisor={addAdvisorPane}
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

      {mode === 'chat' ? <div className="min-h-0 flex-1"><BrainChat /></div> : (
      <div ref={stackRef} className="flex min-h-0 flex-1 flex-col">
        {state.panes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-text-muted">
            <p className="text-sm">{t.advisor.emptyDock}</p>
            <p className="text-xs">{t.advisor.emptyDockHint}</p>
          </div>
        ) : state.panes.map((pane, i) => (
          <div key={pane.id} className="flex min-h-0 flex-col" style={{ flexGrow: state.sizes[i] ?? 1, flexBasis: 0 }}>
            <div className="min-h-0 flex-1">
              <AdvisorPane pane={pane} onRemove={() => removePane(pane.id)} />
            </div>
            {i < state.panes.length - 1 && (
              <ResizeHandle orientation="horizontal" onDelta={(dy) => onSplitDelta(i, dy)} className="w-full" />
            )}
          </div>
        ))}
      </div>
      )}
    </div>
  );

  // The size divider sits on the panel's inner edge: left of the column when docked right, right of
  // it when docked left; below it when docked top, above it when docked bottom.
  const heightHandle = <ResizeHandle orientation="horizontal" onDelta={onHeightDelta} className="w-full" />;
  if (state.side === 'top') return <div className="flex w-full flex-col border-b border-border">{column}{heightHandle}</div>;
  if (state.side === 'bottom') return <div className="flex w-full flex-col border-t border-border">{heightHandle}{column}</div>;
  return state.side === 'right'
    ? <>{widthHandle}{column}</>
    : <>{column}{widthHandle}</>;
}
