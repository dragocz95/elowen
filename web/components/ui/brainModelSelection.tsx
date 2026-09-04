import type { ReactNode } from 'react';
import { ModelIcon } from './ModelIcon';
import { type ManageSelectionItem } from './ManageSelectionModal';
import type { BrainModelOption } from '../../lib/types';

/** The ONE grouping of the brain catalog into manage-selection rows, consumed by every surface that
 *  offers brain models — the Settings role pickers ({@link BrainModelField}) and the Users allowed-models
 *  modal alike — so the two cannot drift. Rows are grouped by the catalog's authoritative
 *  `provider`/`providerLabel`, never by splitting a model id: a model id may itself contain slashes
 *  (`openai/gpt-5.6-sol`), and splitting one would fabricate a provider that does not exist. Each row
 *  keeps the caller's id encoding through `keyOf` (the full exec or role key, so a save round-trips) and
 *  carries the model's brand icon; every group header and filter chip carries the provider's brand icon
 *  from the same name→brand resolver. `pinned` rows (a "default" pick, or a saved id the catalog no
 *  longer lists) keep `group: ''` and render above the grouped sections. */
export function brainModelSelection(
  models: readonly BrainModelOption[],
  keyOf: (m: BrainModelOption) => string,
  pinned: ManageSelectionItem[] = [],
): { items: ManageSelectionItem[]; groupIcons: Record<string, ReactNode> } {
  const items: ManageSelectionItem[] = [
    ...pinned,
    ...models.map((m) => ({
      id: keyOf(m),
      label: m.model,
      group: m.provider,
      groupLabel: m.providerLabel,
      icon: <ModelIcon name={m.model} size={14} />,
    })),
  ];
  const groupIcons = Object.fromEntries(
    [...new Map(models.map((m) => [m.provider, m.providerLabel])).entries()]
      .map(([provider, label]) => [provider, <ModelIcon key={provider} name={label} size={14} />]),
  );
  return { items, groupIcons };
}
