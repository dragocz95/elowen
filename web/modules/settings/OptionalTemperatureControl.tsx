'use client';

import { HelpTip } from '../../components/ui/HelpTip';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';

const DEFAULT_TEMPERATURE = 0.7;

/** Provider-local temperature override. The empty string is the persisted "omit this field" state; zero
 *  remains an enabled, valid override rather than being confused with that empty state. */
export function OptionalTemperatureControl({ value, onChange, label, hint, toggleLabel }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  hint: string;
  toggleLabel: string;
}) {
  const enabled = value.trim() !== '';
  const parsed = Number(value);
  const temperature = enabled && Number.isFinite(parsed) && parsed >= 0 && parsed <= 2
    ? parsed
    : DEFAULT_TEMPERATURE;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}<HelpTip align="left">{hint}</HelpTip>
        </span>
        <Toggle
          checked={enabled}
          onChange={(next) => onChange(next ? String(DEFAULT_TEMPERATURE) : '')}
          label={toggleLabel}
        />
      </div>
      {enabled ? (
        <div className="flex items-center gap-3">
          <Slider
            value={temperature}
            min={0}
            max={2}
            step={0.1}
            onChange={(next) => onChange(String(next))}
            aria-label={label}
            aria-valuetext={temperature.toFixed(1)}
          />
          <span className="w-8 shrink-0 text-right font-mono text-sm tabular-nums text-primary">
            {temperature.toFixed(1)}
          </span>
        </div>
      ) : null}
    </div>
  );
}
