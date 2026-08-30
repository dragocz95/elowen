'use client';

import { useEffect, useId, useState } from 'react';
import { Input } from '../../components/ui/Input';
import { Segmented } from '../../components/ui/Segmented';
import { interpolate, useTranslation } from '../../lib/i18n';

/** Compact whole-day policy editor shared by the token TTL and conversation-retention drawers. Presets
 *  commit immediately; a custom value commits only on blur/Enter and invalid drafts revert locally. */
export function DaysPolicyEditor({ value, presets, label, onCommit }: {
  value: number;
  presets: readonly number[];
  label: string;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [customSelected, setCustomSelected] = useState(!presets.includes(value));
  const [draft, setDraft] = useState(String(value));
  const suffixId = useId();

  useEffect(() => {
    setDraft(String(value));
    setCustomSelected(!presets.includes(value));
  }, [presets, value]);

  const commitCustom = () => {
    const parsed = Number(draft.trim());
    if (!Number.isInteger(parsed) || parsed < 1) {
      setDraft(String(value));
      return;
    }
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="flex flex-col gap-4">
      <Segmented
        aria-label={interpolate(t.settings.daysPolicy.presets, { policy: label })}
        size="sm"
        options={[
          ...presets.map((days) => ({
            value: String(days),
            label: interpolate(t.settings.daysPolicy.preset, { n: String(days) }),
          })),
          { value: 'custom', label: t.settings.daysPolicy.custom },
        ]}
        value={customSelected ? 'custom' : String(value)}
        onChange={(next) => {
          if (next === 'custom') {
            setCustomSelected(true);
            setDraft(String(value));
            return;
          }
          const days = Number(next);
          setCustomSelected(false);
          setDraft(String(days));
          if (days !== value) onCommit(days);
        }}
      />
      {customSelected ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-tiny font-semibold uppercase tracking-wide text-muted-foreground">
            {t.settings.daysPolicy.customValue}
          </span>
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitCustom}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitCustom();
              }}
              className="w-24 text-center"
              aria-label={interpolate(t.settings.daysPolicy.customFor, { policy: label })}
              aria-describedby={suffixId}
            />
            <span id={suffixId} className="text-sm text-muted-foreground">{t.settings.daysPolicy.days}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
