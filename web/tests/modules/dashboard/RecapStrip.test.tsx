import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RecapStrip } from '../../../modules/dashboard/RecapStrip';
import { createWrapper } from '../../test-utils';
import { consumePendingBrainComposer, consumePendingBrainSession } from '../../../lib/brainDock';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { DashRecap } from '../../../lib/types';

const READY: DashRecap = {
  enabled: true,
  continue: [
    { id: 's-1', title: 'Dashboard redesign', updatedAt: '2026-08-30 22:41:00' },
    { id: 's-2', title: 'Teams reactions', updatedAt: '2026-08-30 18:03:00' },
  ],
  yesterday: { turns: 14, tokens: 1_200_000, sessions: ['Dashboard redesign', 'Teams reactions'] },
  digest: {
    status: 'ready',
    summary: 'You mostly worked on the **dashboard redesign**.',
    suggestions: [{ label: 'Finish price tests', prompt: 'Finish the price regression tests' }],
  },
};

function draw(recap: DashRecap | undefined) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><RecapStrip recap={recap} /></Wrapper>);
}

describe('RecapStrip', () => {
  it('renders nothing without data, when disabled, and when there is nothing to say', () => {
    expect(draw(undefined).container).toBeEmptyDOMElement();
    expect(draw({ enabled: false }).container).toBeEmptyDOMElement();
    expect(draw({ enabled: true, continue: [], yesterday: null, digest: { status: 'unavailable' } }).container).toBeEmptyDOMElement();
  });

  it('shows the digest sentence with its emphasis, continue pills and suggestion pills', () => {
    draw(READY);
    // The **bold** marker renders as emphasis, never as literal asterisks.
    expect(screen.getByText('dashboard redesign')).toBeInTheDocument();
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.getByRole('button', { name: /Dashboard redesign/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finish price tests/ })).toBeInTheDocument();
  });

  it('falls back to the deterministic yesterday sentence while the digest is generating', () => {
    draw({ ...READY, digest: { status: 'generating' } });
    expect(screen.getByText(
      en.dashboard.recap.fallback.replace('{sessions}', 'Dashboard redesign, Teams reactions'),
    )).toBeInTheDocument();
  });

  it('a continue pill opens the stored conversation; a suggestion pill seeds the composer', () => {
    draw(READY);
    fireEvent.click(screen.getByRole('button', { name: /Teams reactions/ }));
    expect(consumePendingBrainSession()).toEqual({ sessionId: 's-2', continuable: true });
    fireEvent.click(screen.getByRole('button', { name: /Finish price tests/ }));
    expect(consumePendingBrainComposer()).toBe('Finish the price regression tests');
  });
});
