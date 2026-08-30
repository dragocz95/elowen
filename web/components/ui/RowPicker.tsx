'use client';
import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './Button';
import { ManageSelectionModal, type ManageSelectionItem } from './ManageSelectionModal';

/** The single-choice control a settings record wears when its catalog is too long, too grouped or too
 *  searchable to be a Segmented or a SelectMenu.
 *
 *  It is a TRIGGER, not a card. What it replaced — `SelectionSummary` — is a bordered block with a count
 *  line, sample chips and a "Manage" button beside them; dropped into the trailing cell of a record that
 *  is one grid row tall, it wrapped onto a second and third line and put the row's value at the far side
 *  of a box whose own edge fought the card's. This is one control the width of its cell: the current
 *  pick, truncated, and a chevron saying it opens something. `SelectionSummary` stays for the surfaces
 *  it was designed for — a section body summarising a multi-select, where the chips ARE the content.
 *
 *  The list itself is unchanged: the same {@link ManageSelectionModal} in `single` mode, so search,
 *  group chips, group icons, badges and the pinned-unknown-value rule all behave exactly as they did.
 *
 *  ACCESSIBILITY. `label` names the trigger, the way `SelectMenu` names its own — the visible text is
 *  the current VALUE, which is not what the control is for, and a page with several pickers would
 *  otherwise offer a screen reader a column of unrelated model names. `aria-haspopup="dialog"` and
 *  `aria-expanded` say what pressing it does. Focus returns here on close through the modal's own
 *  `restoreFocus`, since the dialog is mounted on open rather than opened from a Radix trigger. */
/** The surface a picker trigger wears inside a settings record.
 *
 *  The height is the point. A record's controls share ONE height with `Input` and `SelectTrigger` — both
 *  `h-9` — so a card mixing a model picker with a text field reads as one ruled table. Button's own `sm`
 *  size is `h-8`, which is what put the Memory card's pickers 4px shorter than the inputs beside them.
 *
 *  It is exported because three field types in `PluginConfigEditor` and the skins row build their own
 *  trigger around the same `ManageSelectionModal` rather than around this component. Each had copied the
 *  class string by hand, and a copied string is exactly how the heights drifted apart. */
export const ROW_TRIGGER_CLASS = 'h-9 w-full justify-between font-normal';

export function RowPicker({ label, summary, icon, title, subtitle, items, value, onChange, groupIcons, emptySelectionHint, variant = 'outline', className = '' }: {
  /** Accessible name of the trigger — what the record is choosing, not what is currently chosen. */
  label: string;
  /** The current pick, rendered as the trigger's visible text. */
  summary: string;
  /** Brand mark or glyph for the current pick, shown before the summary. */
  icon?: ReactNode;
  /** Modal heading; falls back to `label`. */
  title?: string;
  subtitle?: string;
  items: ManageSelectionItem[];
  value: string;
  onChange: (value: string) => void;
  groupIcons?: Record<string, ReactNode>;
  emptySelectionHint?: string;
  /** `outline` is the record's control. `ghost` is the quiet document treatment for a picker that sits
   *  in running content rather than in a record's trailing cell. */
  variant?: 'outline' | 'ghost';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-row-picker
        className={`${ROW_TRIGGER_CLASS} ${className}`}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon ? <span aria-hidden className="flex shrink-0">{icon}</span> : null}
          <span className="min-w-0 truncate text-left">{summary}</span>
        </span>
        <ChevronDown size={14} aria-hidden className="opacity-60" />
      </Button>
      <ManageSelectionModal
        title={title ?? label}
        subtitle={subtitle}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        groupIcons={groupIcons}
        emptySelectionHint={emptySelectionHint}
        onSave={(next) => onChange([...next][0] ?? '')}
      />
    </>
  );
}
