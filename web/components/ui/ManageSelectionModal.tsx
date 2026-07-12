'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { useTranslation } from '../../lib/i18n';

export interface ManageSelectionItem {
  id: string;
  label: string;
  /** Grouping key — items sharing a group render under one uppercase header.
   *  `''` pins the item to an ungrouped section at the top (no header, no filter chip),
   *  e.g. a "Default" option or a saved id the vocabulary no longer lists. */
  group: string;
  /** Display name for the group header/filter chip (falls back to `group`). */
  groupLabel?: string;
  icon?: ReactNode;
  badges?: { text: string; tone?: 'accent' | 'muted' }[];
  /** Row cannot be toggled (e.g. built-in tools) — rendered faded with `disabledHint`. */
  disabled?: boolean;
  disabledHint?: string;
}

interface ManageSelectionModalProps {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  items: ManageSelectionItem[];
  selected: Set<string>;
  onSave: (next: Set<string>) => void | Promise<void>;
  saving?: boolean;
  /** Shown in the footer instead of the count when nothing is selected (e.g. "empty = all allowed"). */
  emptySelectionHint?: string;
  /** Footer count label, e.g. (n) => `${n} models selected`. Defaults to the generic "{n} selected". */
  countLabel?: (n: number) => string;
  /** Optional icon per group key, shown in the group header and its filter chip. */
  groupIcons?: Record<string, ReactNode>;
  /** Single-select mode: clicking a row REPLACES the selection (radio-like check, no deselect)
   *  and the header chip + footer show the chosen item's label instead of a count. */
  single?: boolean;
}

/** Case- and diacritics-insensitive haystack normalization for the search filter. */
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

const BADGE_TONES = {
  accent: 'border-accent/40 bg-accent/15 text-accent',
  muted: 'border-border bg-elevated text-text-muted',
} as const;

/** Radio-like check for single-select rows — same footprint as the Checkbox, but round. */
function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
        checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-white transition-transform duration-150 ${checked ? 'scale-100' : 'scale-0'}`}
        style={{ transitionTimingFunction: 'var(--ease-spring)' }}
      />
    </span>
  );
}

/** One selectable row — checkbox in multi mode, radio-like dot in single mode. */
function Row({ item, on, single, onToggle }: { item: ManageSelectionItem; on: boolean; single: boolean; onToggle: (item: ManageSelectionItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(item)}
      disabled={item.disabled}
      aria-pressed={on}
      title={item.disabled ? item.disabledHint : undefined}
      className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
        on ? 'border-accent/50 bg-accent/15 text-text' : 'border-border text-text hover:bg-elevated'
      } ${item.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {item.icon ? <span aria-hidden className="shrink-0">{item.icon}</span> : null}
      <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
      {item.badges?.map((b) => (
        <span key={b.text} className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${BADGE_TONES[b.tone ?? 'muted']}`}>
          {b.text}
        </span>
      ))}
      {single ? <RadioDot checked={on} /> : <Checkbox checked={on} />}
    </button>
  );
}

/** Generic "manage selection" modal: search + group filter chips + grouped checkbox rows.
 *  Selection is LOCAL until "Save changes" hands the next set to `onSave`; Cancel/Esc discards.
 *  When `onSave` rejects, the modal stays open so the user can retry (the caller surfaces the error).
 *  `single` turns it into a radio-like picker (a row click replaces the selection); items with
 *  `group: ''` render pinned above the grouped sections (no header, no filter chip). */
export function ManageSelectionModal(props: ManageSelectionModalProps) {
  // Mount the stateful body only while open so local selection re-seeds from `selected` on every open.
  if (!props.open) return null;
  return <ManageSelectionModalBody {...props} />;
}

function ManageSelectionModalBody({
  title, subtitle, onClose, items, selected, onSave, saving = false,
  emptySelectionHint, countLabel, groupIcons, single = false,
}: ManageSelectionModalProps) {
  const { t } = useTranslation();
  const [local, setLocal] = useState<Set<string>>(() => new Set(selected));
  const [query, setQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

  // Unique groups in first-appearance order — drives the filter chips and the section order.
  // Pinned (group '') items live above the sections and never get a chip.
  const groups = useMemo(() => {
    const seen = new Map<string, string>();
    for (const it of items) if (it.group !== '' && !seen.has(it.group)) seen.set(it.group, it.groupLabel ?? it.group);
    return [...seen.entries()].map(([id, label]) => ({ id, label }));
  }, [items]);

  const q = fold(query.trim());
  // Pinned rows ignore the group filter (they belong to no group) but still honor the search.
  const pinned = items.filter((it) => it.group === '' && (!q || fold(it.label).includes(q)));
  const visible = items.filter((it) =>
    it.group !== ''
    && (!groupFilter || it.group === groupFilter)
    && (!q || fold(it.label).includes(q) || fold(it.groupLabel ?? it.group).includes(q)));

  const toggle = (item: ManageSelectionItem) => {
    if (item.disabled) return;
    if (single) { setLocal(new Set([item.id])); return; } // radio semantics — a click replaces the pick
    setLocal((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
      return next;
    });
  };

  // Single mode surfaces the chosen item's label (header chip + footer) instead of a count.
  const chosen = single ? items.find((it) => local.has(it.id)) : undefined;
  const chosenLabel = chosen?.label ?? emptySelectionHint ?? '—';

  const save = async () => {
    try {
      const result = onSave(new Set(local));
      // Synchronous pickers should close in the same interaction frame. Async persistence still
      // keeps the modal open until it resolves so failures remain retryable.
      if (result) await result;
      onClose();
    } catch {
      // The caller surfaces the failure (toast); keep the modal open so the user can retry.
    }
  };

  return (
    <Modal title={title} description={subtitle} onClose={onClose} size="xl">
      <ModalBody gap={4}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.managePicker.searchPlaceholder}
              aria-label={t.managePicker.searchPlaceholder}
              className="w-full rounded-md border border-border bg-surface py-1.5 pl-8 pr-2.5 text-xs text-text outline-none transition-colors focus:border-accent"
            />
          </div>
          <span className="shrink-0 rounded-md border border-accent/40 bg-accent/15 px-2 py-1 text-[11px] font-medium text-accent">
            {single ? chosenLabel : t.managePicker.selectedCount.replace('{n}', String(local.size))}
          </span>
        </div>

        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={t.managePicker.filterByGroup}>
            <button
              type="button"
              role="tab"
              aria-selected={groupFilter === null}
              onClick={() => setGroupFilter(null)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${groupFilter === null ? 'border-border-strong bg-elevated text-text' : 'border-border text-text-muted hover:bg-elevated hover:text-text'}`}
            >
              {t.managePicker.all}
            </button>
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={groupFilter === g.id}
                onClick={() => setGroupFilter(g.id)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${groupFilter === g.id ? 'border-border-strong bg-elevated text-text' : 'border-border text-text-muted hover:bg-elevated hover:text-text'}`}
              >
                {groupIcons?.[g.id]}
                {g.label}
              </button>
            ))}
          </div>
        )}

        {pinned.length === 0 && visible.length === 0
          ? <p className="py-6 text-center text-xs italic text-text-muted">{t.managePicker.noResults}</p>
          : (
            <div className="flex flex-col gap-4">
              {pinned.length > 0 && (
                <ul className="flex flex-col gap-1">
                  {pinned.map((item) => <li key={item.id}><Row item={item} on={local.has(item.id)} single={single} onToggle={toggle} /></li>)}
                </ul>
              )}
              {groups.map((g) => {
                const groupItems = visible.filter((it) => it.group === g.id);
                if (groupItems.length === 0) return null;
                return (
                  <section key={g.id} className="flex flex-col gap-1.5">
                    <h3 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                      {groupIcons?.[g.id]}
                      {g.label}
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {groupItems.map((item) => (
                        <li key={item.id}><Row item={item} on={local.has(item.id)} single={single} onToggle={toggle} /></li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
      </ModalBody>
      <ModalFooter
        status={
          <span className="text-xs text-text-muted">
            {single
              ? chosenLabel
              : local.size === 0 && emptySelectionHint
                ? emptySelectionHint
                : (countLabel ?? ((n: number) => t.managePicker.selectedCount.replace('{n}', String(n))))(local.size)}
          </span>
        }
      >
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>{t.common.cancel}</Button>
        <Button type="button" variant="accent" onClick={save} disabled={saving}>
          {saving ? t.common.saving : t.managePicker.saveChanges}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
