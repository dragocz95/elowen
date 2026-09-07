'use client';
import { useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { brainModelLabel, brainModelQualifiedLabel } from '../../lib/modelProvider';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../../components/ui/shadcn/dropdown-menu';
import { useBrainChat } from './BrainChatProvider';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ModelOptionList } from './ModelOptionList';

/** The trigger's skin. All three open the SAME menu over the same catalog; only the box differs.
 *
 *  `full` is the labelled header control and `compact` the dock's smaller twin. `statusline` is the one
 *  that sits in the metrics band under the conversation, where the model name used to be a plain read-out:
 *  it inherits the band's mono type and muted colour and stays unbordered at rest, because a boxed control
 *  in a row of quiet figures reads as the loudest thing on the page. It admits it is a control on hover,
 *  on focus and while its menu is open. */
type ModelPickerVariant = 'full' | 'compact' | 'statusline';

const TRIGGER_CLASS: Record<ModelPickerVariant, string> = {
  full: 'h-8 max-w-[220px] rounded-md border border-border px-2.5 text-xs',
  compact: 'h-7 max-w-[130px] rounded-md border border-border px-2 text-tiny',
  // No height and no type of its own: the statusline sets both, so the pill matches whichever host row it
  // lands in (the page toolbar's 11px band or the dock's smaller one) and cannot drift from its siblings.
  // The negative margin cancels the padding, so the model name starts exactly where the plain span did.
  // `w-fit` rather than a filled block: the studio skin stretches the model slot with `flex: 1 1 auto`, and
  // a control that took all of it would paint a hover slab across half the band. `max-w-full` is what keeps
  // the truncation working when the slot is the narrower one instead.
  statusline: '-mx-1 w-fit min-w-0 max-w-full rounded px-1 data-[state=open]:bg-accent data-[state=open]:text-foreground',
};

/** The shared model picker: a trigger button (current model + chevron) opening a grouped popover of every
 *  selectable model. Reads the single catalog + switch action off the chat controller (no props catalog,
 *  no second fetch). `full` is a labelled header control, `compact` an icon-sized dock button, and
 *  `statusline` the pill in the metrics band — same component, same data, same menu. Selecting a model
 *  switches the conversation IN PLACE (no SSE reconnect).
 *
 *  The rows themselves are ModelOptionList, shared with the `/model` overlay so the two entry points can
 *  never drift into showing the same catalog two different ways. */
export function ModelPicker({ variant = 'full' }: { variant?: ModelPickerVariant }) {
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

  const label = currentModel ? brainModelLabel({ model: currentModel }) : t.brainChat.modelPicker;
  const qualifiedLabel = currentModel
    ? brainModelQualifiedLabel({ provider, providerLabel, model: currentModel })
    : t.brainChat.modelPicker;

  const inStatusline = variant === 'statusline';

  return (
    <div
      data-testid="chat-model-picker"
      // In the statusline the pill takes the slot the plain model span held, `data-stat` included: the
      // container-query ladder in chat.css and the studio skin's `flex: 1 1 auto` both address the model
      // by that attribute, and a control that dropped it would stop giving way like the read-out did.
      {...(inStatusline ? { 'data-stat': 'model' } : {})}
      className={inStatusline ? 'relative min-w-0' : 'relative shrink-0'}
    >
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={qualifiedLabel}
            // Deliberately not aria-labelled: the visible catalog model name is the trigger's accessible
            // name. The title keeps the provider-qualified identity available for diagnostics, while Radix
            // supplies aria-haspopup/aria-expanded.
            className={`flex items-center gap-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${TRIGGER_CLASS[variant]}`}
          >
            {/* The brand mark the menu rows already carry, so the current model is recognisable at a
                glance and the pill and the list it opens speak the same vocabulary. It is monochrome-safe
                by construction: ModelIcon masks a mono asset with currentColor. */}
            {inStatusline && currentModel ? <ModelIcon name={currentModel} size={12} /> : null}
            <span className="truncate font-mono">{label}</span>
            <ChevronDown size={variant === 'full' ? 14 : 12} className="shrink-0 opacity-60" aria-hidden />
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
