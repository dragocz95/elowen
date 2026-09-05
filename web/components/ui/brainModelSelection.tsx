import type { ReactNode } from 'react';
import { ModelIcon } from './ModelIcon';
import { type ManageSelectionItem } from './ManageSelectionModal';
import type { BrainModelOption } from '../../lib/types';

export interface BrainModelProviderGroup {
  id: string;
  label: string;
  models: BrainModelOption[];
}

/** Group the live brain catalog by its explicit provider identity. Model ids are opaque and may contain
 *  slashes, so no caller may infer a provider by parsing one. Input order is preserved within providers
 *  and provider groups appear in the order the daemon first reported them. */
export function groupBrainModelsByProvider(models: readonly BrainModelOption[]): BrainModelProviderGroup[] {
  const groups = new Map<string, BrainModelProviderGroup>();
  for (const model of models) {
    const existing = groups.get(model.provider);
    if (existing) existing.models.push(model);
    else groups.set(model.provider, { id: model.provider, label: model.providerLabel, models: [model] });
  }
  return [...groups.values()];
}

/** The ONE grouping of the brain catalog into manage-selection rows, consumed by every surface that
 *  offers brain models — the Settings role pickers ({@link BrainModelField}) and the Users allowed-models
 *  modal alike — so the two cannot drift. Each row keeps the caller's complete id encoding through
 *  `keyOf`; every group header and filter chip carries the provider's brand icon from the shared resolver.
 *  `pinned` rows keep `group: ''` and render above the grouped sections. */
export function brainModelSelection(
  models: readonly BrainModelOption[],
  keyOf: (model: BrainModelOption) => string,
  pinned: ManageSelectionItem[] = [],
): { items: ManageSelectionItem[]; groupIcons: Record<string, ReactNode> } {
  const groups = groupBrainModelsByProvider(models);
  const items: ManageSelectionItem[] = [
    ...pinned,
    ...groups.flatMap((group) => group.models.map((model) => ({
      id: keyOf(model),
      label: model.model,
      group: group.id,
      groupLabel: group.label,
      icon: <ModelIcon name={model.model} size={14} />,
    }))),
  ];
  const groupIcons = Object.fromEntries(groups.map((group) => [
    group.id,
    <ModelIcon key={group.id} name={group.label} size={14} />,
  ]));
  return { items, groupIcons };
}
