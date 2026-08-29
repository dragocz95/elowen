'use client';
import { useMemo, type ReactNode } from 'react';
import { type ManageSelectionItem } from './ManageSelectionModal';
import { RowPicker } from './RowPicker';
import { Segmented } from './Segmented';

/** Canonical single-choice field: two or three choices stay inline; larger catalogs use the shared
 *  searchable picker. Unknown persisted values remain selectable so opening the UI never drops data.
 *  `picker="always"` skips the inline form even for short lists (constellation pods pick in the
 *  drawer regardless of count).
 *
 *  Both presentations are now ROW CONTROLS: a Segmented track or a RowPicker trigger, each one line
 *  tall and the width of the record's trailing cell. The picker branch used to render a
 *  `SelectionSummary` card — a bordered block with a chip and a "Manage" button — which is a section
 *  summary rather than a field, and wrapped to two or three lines inside a record. */
export function ChoiceField({ title, options, value, onChange, picker = 'auto', manageAriaLabel }: {
  title: string;
  options: { value: string; label: string; icon?: ReactNode }[];
  value: string;
  onChange: (value: string) => void;
  picker?: 'auto' | 'always';
  /** More specific accessible name when several choices share one page. Defaults to `title`. */
  manageAriaLabel?: string;
}) {
  const items = useMemo<ManageSelectionItem[]>(() => {
    const known = new Set(options.map((option) => option.value));
    return [
      ...(value && !known.has(value) ? [{ id: value, label: value, group: '' }] : []),
      ...options.map((option) => ({ id: option.value, label: option.label, group: '', icon: option.icon })),
    ];
  }, [options, value]);
  if (picker === 'auto' && items.length <= 3) {
    return (
      <Segmented
        aria-label={title}
        size="sm"
        options={items.map((item) => ({ value: item.id, label: item.label }))}
        value={value}
        onChange={onChange}
      />
    );
  }
  const selected = items.find((item) => item.id === value);
  return (
    <RowPicker
      label={manageAriaLabel ?? title}
      title={title}
      summary={selected?.label ?? value}
      icon={selected?.icon}
      items={items}
      value={value}
      onChange={onChange}
    />
  );
}
