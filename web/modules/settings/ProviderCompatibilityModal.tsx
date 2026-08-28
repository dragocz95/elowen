'use client';
import { useState, type ReactNode } from 'react';
import { Activity, BrainCircuit, Braces, Code2, Database, Gauge, RotateCcw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Segmented } from '../../components/ui/Segmented';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import type { BrainProviderCompatibility } from '../../lib/types';

/** Browser seed for a new provider. The daemon resolves the same conservative baseline when an older
 *  client omits the block; providerCompatibilityParity.test.ts keeps both copies identical. */
export const DEFAULT_PROVIDER_COMPATIBILITY: BrainProviderCompatibility = {
  supportsDeveloperRole: false,
  supportsLongCacheRetention: false,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  supportsStore: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_completion_tokens',
};

export interface ProviderCompatibilityValue {
  compatibility: BrainProviderCompatibility;
  /** Empty means the field is omitted from the provider request. */
  temperature: string;
}

/** Number of effective deviations from the conservative profile. Defaults that happen to be true (the
 *  streaming usage total) are not custom settings merely because their switch is on. */
export function providerCompatibilityCustomCount(value: ProviderCompatibilityValue): number {
  const capabilityChanges = (Object.keys(DEFAULT_PROVIDER_COMPATIBILITY) as (keyof BrainProviderCompatibility)[])
    .filter((key) => value.compatibility[key] !== DEFAULT_PROVIDER_COMPATIBILITY[key]).length;
  return capabilityChanges + (value.temperature.trim() ? 1 : 0);
}

function SettingRow({ icon: Icon, label, hint, control, children }: {
  icon: typeof Activity;
  label: string;
  hint: string;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
          <Icon size={18} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
          {label}<HelpTip>{hint}</HelpTip>
        </span>
        {control}
      </div>
      {children}
    </div>
  );
}

/** Explicit editor for extensions an OpenAI-compatible Chat Completions endpoint may implement. Safe
 *  defaults are intentionally quiet; enabling a switch changes the actual wire payload, never merely UI. */
export function ProviderCompatibilityModal({ value, onSave, onClose }: {
  value: ProviderCompatibilityValue;
  onSave: (next: ProviderCompatibilityValue) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const temperatureEnabled = draft.temperature.trim() !== '';
  const temperature = temperatureEnabled && Number.isFinite(Number(draft.temperature)) ? Number(draft.temperature) : 0.7;
  const patchCompatibility = (next: Partial<BrainProviderCompatibility>) =>
    setDraft((current) => ({ ...current, compatibility: { ...current.compatibility, ...next } }));
  const capabilities: {
    key: Exclude<keyof BrainProviderCompatibility, 'maxTokensField'>;
    icon: typeof Activity;
    label: string;
    hint: string;
  }[] = [
    { key: 'supportsLongCacheRetention', icon: Database, label: t.brain.compatibility.supportsLongCacheRetention, hint: t.brain.compatibility.supportsLongCacheRetentionHint },
    { key: 'supportsDeveloperRole', icon: Code2, label: t.brain.compatibility.supportsDeveloperRole, hint: t.brain.compatibility.supportsDeveloperRoleHint },
    { key: 'supportsUsageInStreaming', icon: Activity, label: t.brain.compatibility.supportsUsageInStreaming, hint: t.brain.compatibility.supportsUsageInStreamingHint },
    { key: 'supportsStrictMode', icon: Braces, label: t.brain.compatibility.supportsStrictMode, hint: t.brain.compatibility.supportsStrictModeHint },
    { key: 'supportsStore', icon: ShieldCheck, label: t.brain.compatibility.supportsStore, hint: t.brain.compatibility.supportsStoreHint },
    { key: 'supportsReasoningEffort', icon: BrainCircuit, label: t.brain.compatibility.supportsReasoningEffort, hint: t.brain.compatibility.supportsReasoningEffortHint },
  ];

  return (
    <Modal
      title={t.brain.compatibility.title}
      description={t.brain.compatibility.description}
      icon={SlidersHorizontal}
      size="md"
      onClose={onClose}
    >
      <ModalBody gap={4}>
        <div className="mb-2 flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/5 px-3.5 py-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
            <ShieldCheck size={17} aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-text">{t.brain.compatibility.safeTitle}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{t.brain.compatibility.safeHint}</p>
          </div>
        </div>

        <div className="flex flex-col divide-y divide-border">
          <SettingRow
            icon={Gauge}
            label={t.brain.temperature}
            hint={t.brain.temperatureHint}
            control={(
              <Toggle
                checked={temperatureEnabled}
                onChange={(enabled) => setDraft((current) => ({ ...current, temperature: enabled ? String(temperature) : '' }))}
                label={t.brain.compatibility.temperatureOverride}
              />
            )}
          >
            {temperatureEnabled ? (
              <div className="ml-9 mt-3 flex items-center gap-3">
                <Slider
                  value={temperature}
                  min={0}
                  max={2}
                  step={0.1}
                  onChange={(next) => setDraft((current) => ({ ...current, temperature: String(next) }))}
                  aria-label={t.brain.temperature}
                  aria-valuetext={temperature.toFixed(1)}
                />
                <span className="w-8 shrink-0 text-right font-mono text-sm tabular-nums text-accent">{temperature.toFixed(1)}</span>
              </div>
            ) : null}
          </SettingRow>

          {capabilities.map(({ key, icon, label, hint }) => (
            <SettingRow
              key={key}
              icon={icon}
              label={label}
              hint={hint}
              control={(
                <Toggle
                  checked={draft.compatibility[key]}
                  onChange={(checked) => patchCompatibility({ [key]: checked })}
                  label={label}
                />
              )}
            />
          ))}

          <SettingRow
            icon={SlidersHorizontal}
            label={t.brain.compatibility.maxTokensField}
            hint={t.brain.compatibility.maxTokensFieldHint}
          >
            <div className="ml-9 mt-3">
              <Segmented
                aria-label={t.brain.compatibility.maxTokensField}
                size="sm"
                options={[
                  { value: 'max_completion_tokens', label: 'max_completion_tokens' },
                  { value: 'max_tokens', label: 'max_tokens' },
                ]}
                value={draft.compatibility.maxTokensField}
                onChange={(next) => patchCompatibility({ maxTokensField: next as BrainProviderCompatibility['maxTokensField'] })}
              />
            </div>
          </SettingRow>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button
          variant="ghost"
          icon={RotateCcw}
          onClick={() => setDraft({ compatibility: DEFAULT_PROVIDER_COMPATIBILITY, temperature: '' })}
        >
          {t.brain.compatibility.reset}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" onClick={() => onSave(draft)}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
