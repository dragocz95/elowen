'use client';

import { useState } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';

import { interpolate, useTranslation } from '../../lib/i18n';
import { useMobile } from '../../lib/useMobile';
import { Button } from './Button';
import { Modal, ModalBody } from './Modal';
import { Segmented } from './Segmented';
import { Popover, PopoverContent, PopoverTrigger } from './shadcn/popover';

/** The ONE condensed filter control of the canonical page toolbar.
 *
 *  WHAT IT IS NOT: a search box. A register's text search is a permanent control that narrows rows as
 *  you type; it lives in the toolbar's own `search` slot and never appears in here or as a chip. Folding
 *  it in would put the page's most-used control two clicks away and give it a chip that cannot be read
 *  at a glance. A FILTER is a choice from a known set — a status, a kind, a provider — and that is the
 *  only thing this component holds.
 *
 *  The page owns every value. This component renders the trigger, the panel and the active chips from
 *  what it is given and reports each change straight back, so filter state stays where the query that
 *  consumes it lives (and stays serialisable into the URL) instead of being trapped inside a popover. */
export interface PageFilterOption {
  value: string;
  label: string;
  /** How many records the option leads to. Rendered as the quiet suffix `Segmented` already draws. */
  count?: number;
}

export interface PageFilterField {
  /** Stable identity — the chip key and the panel's field key. */
  id: string;
  label: string;
  options: PageFilterOption[];
  /** Owned by the page. */
  value: string;
  onChange: (value: string) => void;
  /** The value that means "not filtering". It never produces a chip and it is what a chip's reset and
   *  "clear filters" return to. Defaults to the FIRST option, which is the "All" entry every existing
   *  register already puts there. */
  neutralValue?: string;
}

/** The value a field falls back to. Empty string when a caller passes no options at all, which is a
 *  degenerate field rather than an error: it renders an empty group and is never active. */
function neutralValueOf(field: PageFilterField): string {
  return field.neutralValue ?? field.options[0]?.value ?? '';
}

function isActive(field: PageFilterField): boolean {
  return field.value !== neutralValueOf(field);
}

/** `label: option` — the whole point of a chip is that it names WHICH filter is on, not merely that one
 *  is. "Failed" alone does not say whether the page is filtered by status or by outcome. */
function chipName(field: PageFilterField): string {
  const option = field.options.find((candidate) => candidate.value === field.value);
  return `${field.label}: ${option?.label ?? field.value}`;
}

function FilterFields({ fields }: { fields: PageFilterField[] }) {
  return (
    <div className="page-filters__fields">
      {fields.map((field) => (
        <div key={field.id} className="page-filters__field">
          <span className="page-filters__field-label">{field.label}</span>
          <Segmented
            aria-label={field.label}
            variant="menu"
            value={field.value}
            onChange={field.onChange}
            options={field.options.map((option) => ({ value: option.value, label: option.label, count: option.count }))}
          />
        </div>
      ))}
    </div>
  );
}

/** The trigger and the panel behind it. Renders NOTHING for an empty field set: a page with no filters
 *  must not carry a control that opens an empty surface. */
export function PageFilters({ fields }: { fields: PageFilterField[] }) {
  const { t } = useTranslation();
  const phone = useMobile();
  const [open, setOpen] = useState(false);
  const activeCount = fields.filter(isActive).length;

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

/** The active-filter chips, one line below the toolbar row. Each chip names its filter and resets it;
 *  past one active filter the group also offers a single reset for all of them. Nothing renders while
 *  nothing is filtering. */
export function PageFilterChips({ fields }: { fields: PageFilterField[] }) {
  const { t } = useTranslation();
  const active = fields.filter(isActive);
  if (active.length === 0) return null;

  return (
    <div className="page-filters__chips" role="group" aria-label={t.common.filtersActive} data-testid="page-filter-chips">
      {active.map((field) => {
        const name = chipName(field);
        return (
          <button
            key={field.id}
            type="button"
            className="page-filters__chip"
            aria-label={interpolate(t.common.filterRemove, { name })}
            onClick={() => field.onChange(neutralValueOf(field))}
          >
            <span className="page-filters__chip-name">{name}</span>
            <X size={12} aria-hidden />
          </button>
        );
      })}
      {active.length > 1 ? (
        <Button variant="ghost" size="sm" className="page-filters__clear" onClick={() => { for (const field of active) field.onChange(neutralValueOf(field)); }}>
          {t.common.filtersClear}
        </Button>
      ) : null}
    </div>
  );
}
