'use client';

import { useId, useState, type ReactNode } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

import { interpolate, useTranslation } from '../../lib/i18n';
import { useMobile } from '../../lib/useMobile';
import { Button } from './Button';
import { HelpTip } from './HelpTip';
import { Modal, ModalBody } from './Modal';
import { Popover, PopoverContent, PopoverTrigger } from './shadcn/popover';

/** The ONE condensed filter control of the canonical page toolbar.
 *
 *  WHAT IT IS NOT: a search box. A register's text search is a permanent control that narrows rows as
 *  you type; it lives in the toolbar's own `search` slot and never appears in here or as a chip. Folding
 *  it in would put the page's most-used control two clicks away and give it a chip that cannot be read
 *  at a glance.
 *
 *  IT OWNS ALMOST NOTHING, and that is the design. It owns the trigger, whether the panel is open, and
 *  the arithmetic of how many filters are active. It does NOT own what a filter IS. A page hands it a
 *  rendered `control` and says whether that control is currently filtering; the control can be a
 *  Segmented, a Toggle, `DateRangeFilter`, `ProjectFilterPills`, a pair of number inputs, or anything a
 *  page grows next.
 *
 *  The first version of this component took `options` + `value` + `onChange` and decided "active" by
 *  comparing the value to a neutral option. That is a single-select picker wearing a filter's name, and
 *  every real filter in the app already fails it: Memory's grouping and show-category filters are
 *  booleans with no option list, `DateRangeFilter` is a preset plus two dates, `ProjectFilterPills` is a
 *  pill row over live data. Each of those would have had to be flattened into a synthetic option list to
 *  pass through, and the flattening — not the filter — would then decide whether the page was filtered.
 *
 *  So the page states it. `active` is a fact only the page can know, `activeLabel` is the wording only
 *  the page can write, and `onReset` is the undo only the page can perform. The union below makes the
 *  three inseparable: an active field that cannot say what it is doing, or cannot be switched off, does
 *  not typecheck. */
interface PageFilterFieldBase {
  /** Stable identity — the chip key and the panel's field key. */
  id: string;
  /** Names the filter in the panel, and is what the chip's wording should echo. */
  label: string;
  /** The page's own control, already rendered and already wired to the page's state. */
  control: ReactNode;
  /** Optional guidance beside the label, behind the shared help affordance. */
  hint?: string;
}

/** A filter that is currently narrowing the page. It MUST be able to say so and MUST be undoable —
 *  a chip that cannot name its filter tells the reader nothing, and one that cannot clear it is a
 *  dead end. */
interface ActivePageFilterField extends PageFilterFieldBase {
  active: true;
  /** The chip's wording, written by the page. It has to name WHICH filter is on, not merely its value:
   *  "Failed" alone does not say whether the page is filtered by status or by outcome, so a status
   *  filter writes "Status: Failed" and a boolean writes "Grouped by category". */
  activeLabel: string;
  /** Returns this one filter to its neutral state. The chip and "clear filters" both call it. */
  onReset: () => void;
}

interface InactivePageFilterField extends PageFilterFieldBase {
  active: false;
  /** Declared as `never` so the union is enforced in BOTH directions: a field that supplies a chip
   *  wording while claiming to be inactive is a page that has lost track of its own state, and the
   *  compiler says so instead of the chip silently never appearing. */
  activeLabel?: never;
  onReset?: never;
}

export type PageFilterField = ActivePageFilterField | InactivePageFilterField;

/** The active fields, as a narrowed type so the chip code reaches `activeLabel` and `onReset` without
 *  an optional chain that would quietly render a chip nobody can dismiss.
 *
 *  Note what it CANNOT do: it has no access to any control's value — a control is an opaque node here —
 *  so "is this page filtered" is answered by the page's own flag and by nothing else. */
function activeFieldsOf(fields: PageFilterField[]): ActivePageFilterField[] {
  return fields.filter((field): field is ActivePageFilterField => field.active);
}

/** The shared label shell every filter control sits in, so a Toggle, a Segmented and a date range all
 *  read as the same kind of thing in one panel.
 *
 *  It is deliberately NOT `components/ui/Field.tsx`. That field wraps its control in a `<label>`, which
 *  is right for one input and wrong for most filters: a wrapping label binds to the first labelable
 *  descendant, so a radio group would have the field's name attached to its first radio and a two-input
 *  date range to whichever input came first. A labelled `group` names the whole control, whatever the
 *  control turns out to be. */
function PageFilterFieldShell({ field }: { field: PageFilterField }) {
  const labelId = useId();
  return (
    <div className="page-filters__field" role="group" aria-labelledby={labelId}>
      <span className="page-filters__field-label">
        <span id={labelId}>{field.label}</span>
        {field.hint ? <HelpTip align="left">{field.hint}</HelpTip> : null}
      </span>
      <div className="page-filters__field-control">{field.control}</div>
    </div>
  );
}

function FilterFields({ fields }: { fields: PageFilterField[] }) {
  return (
    <div className="page-filters__fields">
      {fields.map((field) => <PageFilterFieldShell key={field.id} field={field} />)}
    </div>
  );
}

/** The trigger and the panel behind it. Renders NOTHING for an empty field set: a page with no filters
 *  must not carry a control that opens an empty surface. */
export function PageFilters({ fields }: { fields: PageFilterField[] }) {
  const { t } = useTranslation();
  const phone = useMobile();
  const [open, setOpen] = useState(false);
  const activeCount = activeFieldsOf(fields).length;

  if (fields.length === 0) return null;

  const label = (
    <>
      {t.common.filters}
      {activeCount > 0 ? <span className="page-filters__count" aria-hidden>{activeCount}</span> : null}
    </>
  );
  // The badge beside the label is decoration; without an accessible name the control announces "Filters 2".
  const accessibleName = activeCount > 0 ? interpolate(t.common.filtersWithCount, { count: activeCount }) : undefined;

  // A phone gets the app's own dialog as a bottom sheet rather than a popover anchored to a control that
  // is a third of the screen wide. Both presentations are the shared primitives: Radix owns the popover's
  // dismissal and focus return, `Modal` owns the sheet's trap, Escape and focus restoration. The trigger
  // is rendered once per branch rather than hoisted, because `asChild` COMPOSES handlers — an `onClick`
  // written for the sheet would still fire beside Radix's own toggle and close the popover as it opened.
  if (phone) {
    return (
      <>
        <Button
          type="button"
          icon={SlidersHorizontal}
          className="page-filters__trigger"
          data-testid="page-filters-trigger"
          aria-label={accessibleName}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
        {open ? (
          <Modal title={t.common.filters} presentation="sheet" size="md" icon={SlidersHorizontal} onClose={() => setOpen(false)}>
            <ModalBody><FilterFields fields={fields} /></ModalBody>
          </Modal>
        ) : null}
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          icon={SlidersHorizontal}
          className="page-filters__trigger"
          data-testid="page-filters-trigger"
          aria-label={accessibleName}
        >
          {label}
        </Button>
      </PopoverTrigger>
      {/* Radix gives the content `role="dialog"`; it has no visible heading, so it names itself. */}
      <PopoverContent align="start" aria-label={t.common.filters} className="page-filters__panel">
        <FilterFields fields={fields} />
      </PopoverContent>
    </Popover>
  );
}

/** The active-filter chips, one line below the toolbar row. Each chip carries its field's own wording
 *  and its own reset; past one active filter the group also offers a single reset for all of them.
 *  Nothing renders while nothing is filtering. */
export function PageFilterChips({ fields }: { fields: PageFilterField[] }) {
  const { t } = useTranslation();
  const active = activeFieldsOf(fields);
  if (active.length === 0) return null;

  return (
    <div className="page-filters__chips" role="group" aria-label={t.common.filtersActive} data-testid="page-filter-chips">
      {active.map((field) => (
        <button
          key={field.id}
          type="button"
          className="page-filters__chip"
          aria-label={interpolate(t.common.filterRemove, { name: field.activeLabel })}
          onClick={field.onReset}
        >
          <span className="page-filters__chip-name">{field.activeLabel}</span>
          <X size={12} aria-hidden />
        </button>
      ))}
      {active.length > 1 ? (
        <Button variant="ghost" size="sm" className="page-filters__clear" onClick={() => { for (const field of active) field.onReset(); }}>
          {t.common.filtersClear}
        </Button>
      ) : null}
    </div>
  );
}
