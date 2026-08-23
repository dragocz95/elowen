'use client';
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useDismiss } from '../../lib/useDismiss';
import { useTranslation } from '../../lib/i18n';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';
import { useBrainChat } from './BrainChatProvider';
import { ModelOptionList } from './ModelOptionList';

/** The shared model picker: a trigger button (current model + chevron) opening a grouped popover of every
 *  selectable model. Reads the single catalog + switch action off the chat controller (no props catalog,
 *  no second fetch). `full` is a labelled header control; `compact` is an icon-sized dock button — same
 *  component, same data. Selecting a model switches the conversation IN PLACE (no SSE reconnect).
 *
 *  The rows themselves are ModelOptionList, shared with the `/model` overlay so the two entry points can
 *  never drift into showing the same catalog two different ways. */
export function ModelPicker({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const { t } = useTranslation();
  const { models, currentModel, provider, modelsLoading, loadModels } = useBrainChat();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on an outside pointer or Escape — the popover is a transient overlay, never a persistent panel.
  useDismiss(rootRef, open, () => setOpen(false));

  const toggle = (): void => {
    setOpen((v) => {
      const next = !v;
      if (next && models === null && !modelsLoading) loadModels(); // fetch once, on first open
      return next;
    });
  };

  const label = currentModel ? brainModelQualifiedLabel({ provider, model: currentModel }) : t.brainChat.modelPicker;

  return (
    <div ref={rootRef} data-testid="chat-model-picker" className="relative shrink-0">
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
          <ModelOptionList onPick={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
