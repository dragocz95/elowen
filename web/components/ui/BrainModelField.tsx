'use client';
import { ModelIcon } from './ModelIcon';
import { brainModelSelection } from './brainModelSelection';
import { RowPicker } from './RowPicker';
import type { BrainModelOption } from '../../lib/types';

/** Single-select brain-model picker: a compact row trigger naming the current model + a Manage modal
 *  that groups the brain catalog by provider through the shared {@link brainModelSelection} grouping —
 *  the same one the Users allowed-models modal consumes. Every group header carries the provider's brand
 *  logo and every row its model brand icon (both via ModelIcon). A pinned row (id `''`) is the "default"
 *  pick when enabled; a saved model the catalog no longer lists stays visible as a pinned, selected row
 *  so a save can never silently drop it. `keyOf` bridges the caller's id encoding (`provider/model` vs
 *  `provider::model`) — the empty string always means "default". */
export function BrainModelField({ value, onChange, models, title, subtitle, defaultLabel, keyOf, allowDefault = true, manageAriaLabel, missingLabel }: {
  value: string;
  onChange: (key: string) => void;
  models: BrainModelOption[];
  title: string;
  subtitle?: string;
  /** Label of the pinned id-`''` row and of the trigger when nothing concrete is picked. */
  defaultLabel: string;
  keyOf: (m: BrainModelOption) => string;
  /** Whether the modal should offer the empty/default choice. */
  allowDefault?: boolean;
  /** Optional context-specific accessible name when the page contains several pickers. */
  manageAriaLabel?: string;
  /** What to call a stored value the catalog no longer offers. The row stays selected either way — a
   *  save must never silently drop it — but the RUNTIME does not honour such a pick: the spawn chain
   *  skips a selection the allow-list refuses, a removed provider makes the route throw, and a stale
   *  compaction pick is discarded. Rendering the bare id as if it were active is what made the page
   *  claim a model no conversation was running on, so a caller that knows the effective fallback passes
   *  the honest sentence here. Optional: absent, the id is shown as before. */
  missingLabel?: string;
}) {
  const selected = models.find((m) => keyOf(m) === value);

  const { items, groupIcons } = brainModelSelection(models, keyOf, [
    ...(allowDefault ? [{ id: '', label: defaultLabel, group: '' }] : []),
    ...(value && !selected ? [{ id: value, label: missingLabel ?? value, group: '', icon: <ModelIcon name={value} size={14} /> }] : []),
  ]);

  const summary = value ? selected?.model ?? missingLabel ?? value : defaultLabel;
  return (
    <RowPicker
      label={manageAriaLabel ?? title}
      title={title}
      subtitle={subtitle}
      summary={summary}
      icon={value && selected ? <ModelIcon name={summary} size={13} /> : undefined}
      items={items}
      value={value}
      onChange={onChange}
      groupIcons={groupIcons}
    />
  );
}
