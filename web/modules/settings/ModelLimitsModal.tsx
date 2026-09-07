'use client';
import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { useTranslation } from '../../lib/i18n';

/** The instance default an unpinned model answers with, for the row preview and the field placeholder
 *  when the daemon reports no descriptor value. Mirrors DEFAULT_MAX_OUTPUT_TOKENS in src/brain/providers.ts. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

/** Tokens the prompt must keep for itself. Mirrors MIN_INPUT_HEADROOM_TOKENS in src/brain/providers.ts —
 *  the daemon clamps to the same rule, so the operator sees the refusal here instead of a number that
 *  quietly becomes something else on the wire. */
const MIN_INPUT_HEADROOM_TOKENS = 8_192;

/** The largest output cap one context window can honour: input and output share it, so the answer budget
 *  has to leave the prompt its headroom. A window too small to grant that headroom yields half of itself,
 *  which keeps the ceiling positive and monotonic. Mirrors `clampOutputTokens` in src/brain/providers.ts. */
export const maxOutputCeiling = (contextWindow: number): number =>
  Math.max(1, Math.max(Math.floor(contextWindow / 2), contextWindow - MIN_INPUT_HEADROOM_TOKENS));

/** The operator's per-model limits: the max context window and the max output tokens per answer. The card
 *  shows a compact read-only preview; the numbers are edited here so the cards stay quiet. Auto-saves on
 *  edit (validation preserved: an invalid entry simply doesn't persist); "Use defaults" clears both
 *  overrides. `onSave` only persists (it must not close the modal). */
export function ModelLimitsModal({ model, initialWindow, initialMaxTokens, effectiveWindow, effectiveMaxTokens, onClose, onSave }: {
  model: string;
  /** Current context-window override, or null when the provider/default value is in effect. */
  initialWindow: number | null;
  /** Current max-output override, or null when the descriptor/default value is in effect. */
  initialMaxTokens: number | null;
  /** Effective window (override, else provider-reported, else default) — shown as the placeholder. */
  effectiveWindow: number;
  /** Effective max output tokens (override, else descriptor, else default) — shown as the placeholder. */
  effectiveMaxTokens: number;
  onClose: () => void;
  onSave: (limits: { contextWindow: number | null; maxTokens: number | null }) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [windowValue, setWindowValue] = useState(initialWindow != null ? String(initialWindow) : '');
  const [tokensValue, setTokensValue] = useState(initialMaxTokens != null ? String(initialMaxTokens) : '');
  const windowNumber = Number(windowValue);
  const tokensNumber = Number(tokensValue);
  const windowValid = windowValue.trim() === '' || (Number.isFinite(windowNumber) && windowNumber >= 1);
  // The ceiling follows the window being edited right now, so raising both at once validates against the
  // new window rather than against the one the modal opened with.
  const ceiling = maxOutputCeiling(
    windowValid && windowValue.trim() ? Math.floor(windowNumber) : effectiveWindow,
  );
  const tokensPositive = tokensValue.trim() === '' || (Number.isFinite(tokensNumber) && tokensNumber >= 1);
  const tokensFits = tokensValue.trim() === '' || !tokensPositive || Math.floor(tokensNumber) <= ceiling;
  // Only an over-ceiling number gets a message: it is the one mistake whose consequence (a silently
  // clamped answer budget) the operator cannot see anywhere else.
  const tokensError = tokensFits ? undefined : t.brain.maxOutputTokensTooLarge.replace('{max}', String(ceiling));
  const valid = windowValid && tokensPositive && tokensFits;
  // Auto-save on edit; invalid input cancels pending work instead of becoming a successful no-op.
  const { status, retry, flush } = useAutoSaveStatus([windowValue, tokensValue], () => onSave({
    contextWindow: windowValue.trim() ? Math.floor(windowNumber) : null,
    maxTokens: tokensValue.trim() ? Math.floor(tokensNumber) : null,
  }), { savable: valid });
  const closeDisabled = status === 'saving' || status === 'error';
  const close = async () => { const finalStatus = await flush(); if (finalStatus !== 'error') onClose(); };
  return (
    <Modal title={t.brain.modelLimits} description={model} onClose={close} closeDisabled={closeDisabled} size="sm" icon={Gauge}>
      <ModalBody>
        <Field label={t.brain.contextWindow} hint={t.help.elowenContextWindow}>
          <Input
            type="number"
            min={1}
            value={windowValue}
            onChange={(e) => setWindowValue(e.target.value)}
            placeholder={String(effectiveWindow)}
            autoFocus
            className="font-mono"
            aria-label={`${t.brain.contextWindow}: ${model}`}
          />
        </Field>
        <Field label={t.brain.maxOutputTokens} hint={t.help.elowenMaxOutputTokens} error={tokensError}>
          {(control) => (
            <Input
              type="number"
              min={1}
              max={ceiling}
              value={tokensValue}
              onChange={(e) => setTokensValue(e.target.value)}
              placeholder={String(effectiveMaxTokens)}
              className="font-mono"
              aria-label={`${t.brain.maxOutputTokens}: ${model}`}
              {...control}
            />
          )}
        </Field>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={retry} />}>
        {/* "Use defaults" is a deliberate clear (an action), so it stays an explicit control — it just
            drives the same auto-save by emptying the fields. */}
        <Button variant="ghost" disabled={!windowValue.trim() && !tokensValue.trim()} onClick={() => { setWindowValue(''); setTokensValue(''); }}>{t.brain.modelLimitsUseDefault}</Button>
        <Button variant="accent" onClick={close} disabled={closeDisabled}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
