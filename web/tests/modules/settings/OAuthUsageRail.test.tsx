import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../../../lib/i18n';
import { OAuthUsageRail } from '../../../modules/settings/OAuthUsageRail';

function renderRail(usedPercent: number) {
  return render(
    <LanguageProvider>
      <OAuthUsageRail usage={{
        provider: 'anthropic',
        planType: null,
        windows: [{ usedPercent, windowMinutes: 300, resetsAt: null }],
        fetchedAt: 0,
        stale: false,
      }} />
    </LanguageProvider>,
  );
}

describe('OAuth usage rail', () => {
  it('keeps a tiny usage visible without overstating it to assistive technology', () => {
    renderRail(1);
    const progress = screen.getByRole('progressbar', { name: '5h' });
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress.querySelector('[data-slot="progress-indicator"]')).toHaveStyle({ width: '3%' });
    expect(screen.getByText('1%')).toBeInTheDocument();
  });
});
