'use client';
import { BackendPicker } from './BackendPicker';
import { useTranslation } from '../../lib/i18n';

interface Model { label: string; exec: string }

/**
 * Shared task-executor field. The compact page surface shows only the current choice and opens the
 * same searchable, provider-grouped single-select modal used by the rest of Elowen. Keeping this
 * adapter preserves the task/onboarding API while removing the old inline provider/model pill tree.
 */
export function ExecutorPicker({ value, onChange, models, defaultLabel, allowDefault = true, kind = 'all' }: {
  value: string;
  onChange: (exec: string) => void;
  models: Model[];
  defaultLabel?: string;
  /** Retained for call-site compatibility; the shared manage modal owns progressive disclosure. */
  moreLabel?: string;
  limit?: number;
  allowDefault?: boolean;
  kind?: 'all' | 'brain';
}) {
  const { t } = useTranslation();
  return (
    <BackendPicker
      value={value}
      onChange={onChange}
      models={models}
      relayLabel={defaultLabel ?? t.tasks.defaultExecutor}
      allowRelay={allowDefault}
      kind={kind}
      title={t.tasks.fieldExecutor}
    />
  );
}
