import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { SessionPicker } from '../../../modules/advisor/SessionPicker';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function renderPicker(ui: React.ReactElement) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper>{ui}</Wrapper>);
}

describe('SessionPicker', () => {
  it('lists running sessions except the excluded ones and picks one on click', async () => {
    const onPick = vi.fn();
    server.use(http.get('*/api/sessions', () => HttpResponse.json([
      { name: 'orca-w1', role: 'agent', agent: 'w1' },
      { name: 'orca-advisor-1', role: 'advisor', agent: 'advisor-1' },
    ])));
    renderPicker(<SessionPicker open onPick={onPick} onClose={vi.fn()} exclude={['orca-advisor-1']} />);

    const row = await screen.findByRole('menuitem', { name: /w1/ });
    expect(screen.queryByRole('menuitem', { name: /advisor-1/ })).toBeNull();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith('orca-w1');
  });

  it('shows the empty state when every session is excluded', async () => {
    server.use(http.get('*/api/sessions', () => HttpResponse.json([
      { name: 'orca-w1', role: 'agent', agent: 'w1' },
    ])));
    renderPicker(<SessionPicker open onPick={vi.fn()} onClose={vi.fn()} exclude={['orca-w1']} />);
    expect(await screen.findByText(/no running sessions|žádné běžící session/i)).toBeTruthy();
  });
});
