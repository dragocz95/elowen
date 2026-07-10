'use client';
import { useState } from 'react';
import { ModelIcon } from './ModelIcon';
import { ManageSelectionModal, type ManageSelectionItem } from './ManageSelectionModal';
import { SelectionSummary } from './SelectionSummary';
import { useTranslation } from '../../lib/i18n';

/** Single-select model picker over a flat, provider-scoped catalog of model ids (the provider is chosen
 *  elsewhere, so there is no provider grouping). A compact summary chip + a manage modal whose rows carry
 *  the model's brand icon; a pinned row (id '') clears the pick, and a saved model the catalog no longer
 *  lists stays visible as a pinned, selected row so a save can never silently drop it. */
export function ModelCatalogField({ value, onChange, catalog, title, subtitle, variant = 'default' }: {
  value: string;
  onChange: (v: string) => void;
  catalog: string[];
  title: string;
  subtitle?: string;
  variant?: 'default' | 'line';
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const items: ManageSelectionItem[] = [
    { id: '', label: t.managePicker.none, group: '' },
    ...(value && !catalog.includes(value) ? [{ id: value, label: value, group: '', icon: <ModelIcon name={value} size={14} /> }] : []),
    ...catalog.map((m) => ({ id: m, label: m, group: '', icon: <ModelIcon name={m} size={14} /> })),
  ];
  return (
    <>
      <SelectionSummary
        countText=""
        samples={[value ? { label: value, icon: <ModelIcon name={value} size={13} /> } : { label: t.managePicker.none }]}
        moreCount={0}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
        variant={variant}
      />
      <ManageSelectionModal
        title={title}
        subtitle={subtitle}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        onSave={(next) => onChange([...next][0] ?? '')}
      />
    </>
  );
}
