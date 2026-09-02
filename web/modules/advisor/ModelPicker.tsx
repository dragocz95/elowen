'use client';
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { brainModelQualifiedLabel } from '../../lib/modelProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../../components/ui/shadcn/dropdown-menu';
import { useBrainChat } from './BrainChatProvider';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
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
  const { models, currentModel, provider, providerLabel, modelsLoading, loadModels, modelStatus, retryModel } = useBrainChat();
  const [open, setOpen] = useState(false);
  const firstOpenHandled = useRef(false);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (!next || firstOpenHandled.current) return;
    firstOpenHandled.current = true;
    if (models === null && !modelsLoading) loadModels();
  };

  const label = currentModel ? brainModelQualifiedLabel({ provider, providerLabel, model: currentModel }) : t.brainChat.modelPicker;

  return (
    <div data-testid="chat-model-picker" className="relative shrink-0">
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={label}
            // Deliberately NOT aria-labelled: the trigger is named by its qualified model so a user with
            // several chat panes open can tell which model each one is on. Radix supplies
            // aria-haspopup/aria-expanded here, and tests/modules/ModelPicker.test.tsx pins the name.
            className={`flex items-center gap-1.5 rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
              variant === 'compact' ? 'h-7 max-w-[130px] px-2 text-tiny' : 'h-8 max-w-[220px] px-2.5 text-xs'
            }`}
          >
            <span className="truncate font-mono">{label}</span>
            <ChevronDown size={variant === 'compact' ? 12 : 14} className="shrink-0 opacity-60" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label={t.brainChat.modelPicker}
          align="end"
          sideOffset={4}
          className="max-h-80 w-64 p-0 py-1"
        >
          <ModelOptionList presentation="menu" />
        </DropdownMenuContent>
      </DropdownMenu>
      <AutoSaveStatus status={modelStatus} onRetry={retryModel} />
    </div>
  );
}
