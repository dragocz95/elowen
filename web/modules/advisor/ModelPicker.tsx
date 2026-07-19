'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import type { BrainModelOption } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';

/** Short auth-source badge on each provider group — mirrors the `source` field the daemon derives from how
 *  the provider authenticates (drives the OAuth badge in every picker). Stable technical tokens, identical
 *  in every locale. */
const SOURCE_BADGE: Record<BrainModelOption['source'], string> = {
  oauth: 'OAuth',
  'api-key': 'API',
  relay: 'Relay',
};

/** Group the flat catalog into ordered provider buckets keyed by the provider's display label, preserving
 *  the server's ordering (first occurrence wins the slot). */
function groupByProvider(models: BrainModelOption[]): { label: string; source: BrainModelOption['source']; items: BrainModelOption[] }[] {
  const groups: { label: string; source: BrainModelOption['source']; items: BrainModelOption[] }[] = [];
  for (const m of models) {
    let group = groups.find((g) => g.label === m.providerLabel);
    if (!group) { group = { label: m.providerLabel, source: m.source, items: [] }; groups.push(group); }
    group.items.push(m);
  }
  return groups;
}

/** The shared model picker: a trigger button (current model + chevron) opening a grouped popover of every
 *  selectable model. Reads the single catalog + switch action off the chat controller (no props catalog,
 *  no second fetch). `full` is a labelled header control; `compact` is an icon-sized dock button — same
 *  component, same data. Selecting a model switches the conversation IN PLACE (no SSE reconnect). */
export function ModelPicker({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t } = useTranslation();
  const { models, currentModel, setModel, modelsLoading, modelsError, loadModels } = useBrainChat();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside pointer or Escape — the popover is a transient overlay, never a persistent panel.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const toggle = (): void => {
    setOpen((v) => {
      const next = !v;
      if (next && models === null && !modelsLoading) loadModels(); // fetch once, on first open
      return next;
    });
  };

  const groups = models ? groupByProvider(models) : [];
  const label = currentModel || t.brainChat.modelPicker;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        className={`flex items-center gap-1.5 rounded-md border border-border text-text-muted transition-colors hover:bg-elevated hover:text-text ${
          variant === 'compact' ? 'h-7 max-w-[130px] px-2 text-tiny' : 'h-8 max-w-[220px] px-2.5 text-xs'
        }`}
      >
        <span className="truncate font-mono">{label}</span>
        <ChevronDown size={variant === 'compact' ? 12 : 14} className="shrink-0" aria-hidden />
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label={t.brainChat.modelPicker}
          className="absolute right-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-border bg-elevated py-1 shadow-lg"
        >
          {modelsLoading ? (
            <div className="px-3 py-2 text-tiny italic text-text-muted">{t.brainChat.modelPickerLoading}</div>
          ) : modelsError ? (
            <div className="flex flex-col gap-1.5 px-3 py-2 text-tiny text-text-muted">
              <span>{t.brainChat.modelPickerError}</span>
              <button
                type="button"
                onClick={() => loadModels()}
                className="self-start rounded-md border border-border px-2 py-0.5 text-tiny text-text transition-colors hover:bg-bg"
              >
                {t.brainChat.modelPickerRetry}
              </button>
            </div>
          ) : groups.length === 0 ? (
            <div className="px-3 py-2 text-tiny italic text-text-muted">{t.brainChat.modelPickerEmpty}</div>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="py-0.5">
                <div className="flex items-center gap-1.5 px-3 py-1 text-tiny font-medium uppercase tracking-wide text-text-muted">
                  <span className="truncate">{group.label}</span>
                  <span className="shrink-0 rounded bg-bg px-1 py-0.5 text-[0.6rem] font-normal normal-case tracking-normal text-text-muted">
                    {SOURCE_BADGE[group.source]}
                  </span>
                </div>
                {group.items.map((m) => {
                  const active = m.model === currentModel;
                  const levels = m.reasoningLevels ?? [];
                  return (
                    <button
                      key={`${m.provider}/${m.model}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => { setModel(m); setOpen(false); }}
                      className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-bg ${active ? 'text-text' : 'text-text-muted'}`}
                    >
                      <span className="flex items-center gap-1.5">
                        {active ? <Check size={12} className="shrink-0 text-accent" aria-label={t.brainChat.modelActive} /> : <span className="w-3 shrink-0" aria-hidden />}
                        <span className="truncate font-mono text-sm">{m.model}</span>
                      </span>
                      {levels.length > 0 ? (
                        <span className="flex flex-wrap gap-1 pl-[1.125rem]" title={t.brainChat.modelReasoning}>
                          {levels.map((level) => (
                            <span key={level} className="rounded bg-bg px-1 py-0.5 text-[0.6rem] text-text-muted">
                              {m.reasoningLabels?.[level] ?? level}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
