import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { ModelLimitsModal, maxOutputCeiling } from '../../../modules/settings/ModelLimitsModal';

const MODEL = 'qwen3.6-35b-a3b';

/** Renders the editor and collects what it persists. Saves are debounced, so every case drives them the
 *  way the operator does: by closing the modal, which flushes the pending write. */
function renderModal(over: Partial<Parameters<typeof ModelLimitsModal>[0]> = {}) {
  const saved: { contextWindow: number | null; maxTokens: number | null }[] = [];
  const onClose = vi.fn();
  render(
    <LanguageProvider>
      <ModelLimitsModal
        model={MODEL}
        initialWindow={null}
        initialMaxTokens={null}
        effectiveWindow={200_000}
        effectiveMaxTokens={8_192}
        onClose={onClose}
        onSave={(limits) => { saved.push(limits); }}
        {...over}
      />
    </LanguageProvider>,
  );
  const windowInput = screen.getByLabelText(`Context window: ${MODEL}`);
  const tokensInput = screen.getByLabelText(`Max output tokens: ${MODEL}`);
  const done = () => fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  return { saved, onClose, windowInput, tokensInput, done };
}

describe('ModelLimitsModal', () => {
  it('shows the effective values as placeholders while nothing is pinned', () => {
    const { windowInput, tokensInput } = renderModal();
    expect(windowInput).toHaveValue(null);
    expect(windowInput).toHaveAttribute('placeholder', '200000');
    expect(tokensInput).toHaveValue(null);
    expect(tokensInput).toHaveAttribute('placeholder', '8192');
  });

  it('persists the max output tokens the operator typed', async () => {
    const { saved, tokensInput, done } = renderModal();
    fireEvent.change(tokensInput, { target: { value: '65536' } });
    done();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ contextWindow: null, maxTokens: 65_536 });
  });

  it('persists both limits from one save', async () => {
    const { saved, windowInput, tokensInput, done } = renderModal();
    fireEvent.change(windowInput, { target: { value: '262144' } });
    fireEvent.change(tokensInput, { target: { value: '65536' } });
    done();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ contextWindow: 262_144, maxTokens: 65_536 });
  });

  it('clears both overrides with "Use defaults"', async () => {
    const { saved, done } = renderModal({ initialWindow: 262_144, initialMaxTokens: 65_536 });
    fireEvent.click(screen.getByRole('button', { name: 'Use defaults' }));
    done();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ contextWindow: null, maxTokens: null });
  });

  it('clears just the output cap when its field is emptied', async () => {
    const { saved, tokensInput, done } = renderModal({ initialWindow: 262_144, initialMaxTokens: 65_536 });
    fireEvent.change(tokensInput, { target: { value: '' } });
    done();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ contextWindow: 262_144, maxTokens: null });
  });

  // Input and output share the window, so a cap larger than the window minus the prompt's headroom is a
  // number the endpoint can never honour. It is refused here rather than silently clamped on the wire.
  it('refuses an output cap the context window cannot honour', async () => {
    const { saved, tokensInput, done } = renderModal({ initialWindow: 32_000 });
    fireEvent.change(tokensInput, { target: { value: '32000' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(String(maxOutputCeiling(32_000)));
    expect(tokensInput).toHaveAttribute('aria-invalid', 'true');
    done();
    // The flush is deliberately given a moment: a refused value must not persist late either.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved).toHaveLength(0);
  });

  it('validates against the window being edited, not the one it opened with', async () => {
    const { saved, windowInput, tokensInput, done } = renderModal({ initialWindow: 32_000 });
    fireEvent.change(tokensInput, { target: { value: '65536' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.change(windowInput, { target: { value: '262144' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    done();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ contextWindow: 262_144, maxTokens: 65_536 });
  });
});
