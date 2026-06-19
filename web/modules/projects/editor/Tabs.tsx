'use client';
import { X } from 'lucide-react';
import { basename } from './helpers';

/** Open-file tabs (VS Code-like). A dirty file shows an accent dot that turns into a close button on
 *  hover. Switching tabs never discards edits (drafts live in the parent). */
export function Tabs({ tabs, active, dirty, onSelect, onClose, closeLabel }: {
  tabs: string[]; active: string | null; dirty: Set<string>;
  onSelect: (p: string) => void; onClose: (p: string) => void; closeLabel: string;
}) {
  if (tabs.length === 0) return null;
  return (
    <div className="flex items-stretch overflow-x-auto border-b border-border bg-bg/40">
      {tabs.map((p) => {
        const isActive = p === active;
        const isDirty = dirty.has(p);
        return (
          <div key={p} className={`group flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs ${isActive ? 'bg-surface text-text' : 'text-text-muted hover:bg-elevated'}`}>
            <button type="button" onClick={() => onSelect(p)} className="max-w-40 truncate" title={p}>{basename(p)}</button>
            <button type="button" onClick={() => onClose(p)} aria-label={closeLabel} className="flex h-4 w-4 items-center justify-center rounded text-text-muted hover:bg-bg hover:text-text">
              {isDirty ? <span className="h-1.5 w-1.5 rounded-full bg-accent group-hover:hidden" aria-hidden /> : null}
              <X size={11} className={isDirty ? 'hidden group-hover:block' : 'block'} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
