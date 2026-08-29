'use client';
import { ModelIcon } from './ModelIcon';
import { type ManageSelectionItem } from './ManageSelectionModal';
import { RowPicker } from './RowPicker';
import { useTranslation } from '../../lib/i18n';

/** Single-select model picker over a flat, provider-scoped catalog of model ids (the provider is chosen
 *  elsewhere, so there is no provider grouping). A compact row trigger naming the current model + a
 *  manage modal whose rows carry the model's brand icon; a pinned row (id '') clears the pick, and a
 *  saved model the catalog no longer lists stays visible as a pinned, selected row so a save can never
 *  silently drop it. */
export function ModelCatalogField({ value, onChange, catalog, title, subtitle, variant = 'default' }: {
  value: string;
  onChange: (v: string) => void;
  catalog: string[];
  title: string;
  subtitle?: string;
  /** `line` is the quiet document treatment for a picker in running content: the trigger drops its
   *  border, exactly as the summary this replaced dropped its card chrome. */
  variant?: 'default' | 'line';
}) {
  const { t } = useTranslation();
  const items: ManageSelectionItem[] = [
    { id: '', label: t.managePicker.none, group: '' },
    ...(value && !catalog.includes(value) ? [{ id: value, label: value, group: '', icon: <ModelIcon name={value} size={14} /> }] : []),
    ...catalog.map((m) => ({ id: m, label: m, group: '', icon: <ModelIcon name={m} size={14} /> })),
  ];
  return (
    <RowPicker
      label={title}
      subtitle={subtitle}
      summary={value || t.managePicker.none}
      icon={value ? <ModelIcon name={value} size={13} /> : undefined}
      items={items}
      value={value}
      onChange={onChange}
      variant={variant === 'line' ? 'ghost' : 'outline'}
    />
  );
}
