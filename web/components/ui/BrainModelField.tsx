'use client';
import { ModelIcon } from './ModelIcon';
import { type ManageSelectionItem } from './ManageSelectionModal';
import { RowPicker } from './RowPicker';
import type { BrainModelOption } from '../../lib/types';

/** Single-select brain-model picker: a compact row trigger naming the current model + a Manage modal
 *  that groups the brain catalog by provider. Every group header carries the provider's brand logo and
 *  every row its model brand icon (both via ModelIcon, matching the users-admin allowed-models modal). A
 *  pinned row (id `''`) is the "default" pick when enabled; a saved model the catalog no longer lists
 *  stays visible as a pinned, selected row so a save can never silently drop it. `keyOf` bridges the
 *  caller's id encoding (`provider/model` vs `provider::model`) — the empty string always means
 *  "default". */
export function BrainModelField({ value, onChange, models, title, subtitle, defaultLabel, keyOf, allowDefault = true, manageAriaLabel }: {
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
}) {
  const selected = models.find((m) => keyOf(m) === value);

  const items: ManageSelectionItem[] = [
    ...(allowDefault ? [{ id: '', label: defaultLabel, group: '' }] : []),
    ...(value && !selected ? [{ id: value, label: value, group: '', icon: <ModelIcon name={value} size={14} /> }] : []),
    ...models.map((m) => ({
      id: keyOf(m),
      label: m.model,
      group: m.provider,
      groupLabel: m.providerLabel,
      icon: <ModelIcon name={m.model} size={14} />,
    })),
  ];
  // Provider brand logo on each group header/chip, resolved from the provider label (Anthropic, OpenAI…);
  // custom endpoints with no known brand fall back to the generic glyph. Keyed by provider id.
  const groupIcons = Object.fromEntries(
    [...new Map(models.map((m) => [m.provider, m.providerLabel])).entries()]
      .map(([provider, label]) => [provider, <ModelIcon key={provider} name={label} size={14} />]),
  );

  const summary = value ? selected?.model ?? value : defaultLabel;
  return (
    <RowPicker
      label={manageAriaLabel ?? title}
      title={title}
      subtitle={subtitle}
      summary={summary}
      icon={value ? <ModelIcon name={summary} size={13} /> : undefined}
      items={items}
      value={value}
      onChange={onChange}
      groupIcons={groupIcons}
    />
  );
}
