import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { BrainSection } from '../../modules/settings/BrainSection';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

const CONFIG = {
  brain: {
    agentName: 'Elowen',
    maxSteps: 20,
    limits: {
      toolOutputMaxLines: 80, toolOutputMaxChars: 12000, elicitationTimeoutMs: 300000,
      memoryRecallCount: 6, memoryRecallChars: 1500, goalTurnBudget: 8, goalMaxTurns: 64, channelSessionCap: 32,
    },
    providers: [] as unknown[],
  },
};

let putBody: unknown = null;
const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json(CONFIG)),
  http.put('*/api/config', async ({ request }) => { putBody = await request.json(); return HttpResponse.json(CONFIG); }),
  http.get('*/api/brain/oauth/status', () => HttpResponse.json({})),
);
beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => { server.resetHandlers(); putBody = null; localStorage.clear(); });
afterAll(() => server.close());

const renderBrain = () => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainSection /></ToastProvider></Wrapper>);
};

describe('BrainSection limits — collapsed into a modal (no longer an inline 8-field grid)', () => {
  it('renders a trigger, not the inline limit inputs', async () => {
    renderBrain();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit limits' })).toBeTruthy());
    // The eight numeric fields must NOT be inline anymore — they only exist inside the modal.
    expect(screen.queryByLabelText('Memory recall — count')).toBeNull();
  });

  it('opens the modal with the 8 limit fields and closes on Escape', async () => {
    renderBrain();
    const trigger = await screen.findByRole('button', { name: 'Edit limits' });
    fireEvent.click(trigger);
    // All eight fields present, keyed by their aria-labels.
    for (const label of ['Tool output — lines', 'Tool output — characters', 'Question timeout (ms)', 'Memory recall — count', 'Memory recall — characters', 'Goal turn budget', 'Goal safety ceiling', 'Live channel sessions']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByLabelText('Memory recall — count')).toBeNull());
  });

  it('still autosaves live: editing a field inside the modal PUTs brain.limits (no Save button)', async () => {
    renderBrain();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit limits' }));
    const field = screen.getByLabelText('Memory recall — count') as HTMLInputElement;
    // No manual Save in the modal — edits flow straight to the autosaving `limits` state.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.change(field, { target: { value: '12' } });
    await waitFor(
      () => expect((putBody as { brain: { limits: { memoryRecallCount: number } } })?.brain?.limits?.memoryRecallCount).toBe(12),
      { timeout: 3000 },
    );
  });
});
