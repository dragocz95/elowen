import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import {
  DEFAULT_PROVIDER_COMPATIBILITY,
  ProviderCompatibilityModal,
  providerCompatibilityCustomCount,
  type ProviderCompatibilityValue,
} from '../../../modules/settings/ProviderCompatibilityModal';

const initial = (overrides: Partial<ProviderCompatibilityValue> = {}): ProviderCompatibilityValue => ({
  compatibility: { ...DEFAULT_PROVIDER_COMPATIBILITY },
  temperature: '',
  ...overrides,
});

function renderModal(value = initial()) {
  const onSave = vi.fn();
  render(
    <LanguageProvider>
      <ProviderCompatibilityModal value={value} onSave={onSave} onClose={() => {}} />
    </LanguageProvider>,
  );
  return { onSave };
}

describe('ProviderCompatibilityModal', () => {
  it('does not count enabled safe defaults as custom settings', () => {
    expect(providerCompatibilityCustomCount(initial())).toBe(0);
    expect(providerCompatibilityCustomCount(initial({ compatibility: {
      ...DEFAULT_PROVIDER_COMPATIBILITY,
      supportsLongCacheRetention: true,
    } }))).toBe(1);
  });

  it('starts from the conservative endpoint profile', () => {
    renderModal();
    expect(screen.getByText('Conservative by default')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '24-hour prompt cache' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('switch', { name: 'Streaming usage totals' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('slider', { name: 'Temperature' })).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.getByRole('radio', { name: 'max_completion_tokens' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves switches, the temperature slider and the token-limit field as one typed value', () => {
    const { onSave } = renderModal();
    fireEvent.click(screen.getByRole('switch', { name: 'Override model temperature' }));
    const temperature = screen.getByRole('slider', { name: 'Temperature' });
    expect(temperature).toHaveAttribute('aria-valuemin', '0');
    expect(temperature).toHaveAttribute('aria-valuemax', '2');
    fireEvent.keyDown(temperature, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('switch', { name: '24-hour prompt cache' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Strict tool schemas' }));
    fireEvent.click(screen.getByRole('radio', { name: 'max_tokens' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onSave).toHaveBeenCalledWith({
      temperature: '0.8',
      compatibility: {
        ...DEFAULT_PROVIDER_COMPATIBILITY,
        supportsLongCacheRetention: true,
        supportsStrictMode: true,
        maxTokensField: 'max_tokens',
      },
    });
  });

  it('keeps zero as an enabled temperature override', () => {
    const { onSave } = renderModal(initial({ temperature: '0' }));
    expect(screen.getByRole('slider', { name: 'Temperature' })).toHaveAttribute('aria-valuetext', '0.0');
    expect(screen.queryByRole('spinbutton')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onSave).toHaveBeenCalledWith({ compatibility: DEFAULT_PROVIDER_COMPATIBILITY, temperature: '0' });
  });

  it('stores an empty string when the temperature override is switched off', () => {
    const { onSave } = renderModal(initial({ temperature: '1.2' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Override model temperature' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onSave).toHaveBeenCalledWith({ compatibility: DEFAULT_PROVIDER_COMPATIBILITY, temperature: '' });
  });

  it('resets every extension and temperature override together', () => {
    const { onSave } = renderModal(initial({
      temperature: '1.4',
      compatibility: {
        ...DEFAULT_PROVIDER_COMPATIBILITY,
        supportsLongCacheRetention: true,
        supportsDeveloperRole: true,
        maxTokensField: 'max_tokens',
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to safe defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onSave).toHaveBeenCalledWith({ compatibility: DEFAULT_PROVIDER_COMPATIBILITY, temperature: '' });
  });
});
