'use client';
import { useState } from 'react';
import { X, PanelLeft, PanelRight, PanelTop, PanelBottom } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { ResizeHandle } from '../../components/ui/ResizeHandle';
import { BrainChat } from './BrainChat';
import type { UseDockState, DockSide } from '../../lib/useDockState';
export function AdvisorPanel({ dock }: { dock: UseDockState }) {
  const { t } = useTranslation();
  const { state, setOpen, setSide, setWidth, setHeight } = dock;
  const [sideMenuOpen, setSideMenuOpen] = useState(false);
  const horizontal = state.side === 'left' || state.side === 'right';
  const options: { side: DockSide; Icon: typeof PanelLeft; label: string }[] = [
    { side: 'left', Icon: PanelLeft, label: t.advisor.dockLeft }, { side: 'right', Icon: PanelRight, label: t.advisor.dockRight },
    { side: 'top', Icon: PanelTop, label: t.advisor.dockTop }, { side: 'bottom', Icon: PanelBottom, label: t.advisor.dockBottom },
  ];
  const ActiveIcon = options.find((option) => option.side === state.side)!.Icon;
  const panel = <div className={`flex shrink-0 flex-col overflow-hidden border-border bg-surface ${horizontal ? 'h-full' : 'w-full'}`} style={horizontal ? { width: `min(${state.width}px, 100vw)` } : { height: `min(${state.height}px, 85vh)` }}>
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5"><span className="text-sm font-medium">{t.advisor.title}</span><div className="flex-1" />
      <div className="relative"><button type="button" onClick={() => setSideMenuOpen((v) => !v)} aria-label={t.advisor.dockPosition} className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-elevated hover:text-text"><ActiveIcon size={16} /></button>
        {sideMenuOpen ? <div className="absolute right-0 top-8 z-30 flex gap-0.5 rounded-md border border-border bg-surface p-0.5 shadow-lg">{options.map(({ side, Icon, label }) => <button key={side} type="button" onClick={() => { setSide(side); setSideMenuOpen(false); }} aria-label={label} className={`flex h-7 w-7 items-center justify-center rounded ${side === state.side ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-elevated hover:text-text'}`}><Icon size={15} /></button>)}</div> : null}
      </div>
      <button type="button" onClick={() => setOpen(false)} aria-label={t.advisor.close} className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-elevated hover:text-text"><X size={16} /></button>
    </div>
    <div className="min-h-0 flex-1"><BrainChat /></div>
  </div>;
  const handle = horizontal ? <ResizeHandle orientation="vertical" onDelta={(dx) => setWidth(state.width + (state.side === 'right' ? -dx : dx))} className="h-full" /> : <ResizeHandle orientation="horizontal" onDelta={(dy) => setHeight(state.height + (state.side === 'bottom' ? -dy : dy))} />;
  if (state.side === 'left' || state.side === 'top') return <>{panel}{handle}</>;
  return <>{handle}{panel}</>;
}
