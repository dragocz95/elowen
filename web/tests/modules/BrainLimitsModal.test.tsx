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
      toolOutputMaxLines: 80, toolOutputMaxChars: 30000, elicitationTimeoutMs: 300000,
      memoryRecallCount: 6, memoryRecallChars: 1500, goalTurnBudget: 8, goalMaxTurns: 64, channelSessionCap: 32,
      delegateContextChars: 20000,
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

describe('BrainSection limits — collapsed into a drawer', () => {
  it('renders a trigger, not the inline limit sliders', async () => {
    renderBrain();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit limits' })).toBeTruthy());
    expect(screen.queryByRole('slider', { name: 'Memory recall — count' })).toBeNull();
  });

  it('opens the drawer with all limit sliders and closes on Escape', async () => {
    renderBrain();
    const trigger = await screen.findByRole('button', { name: 'Edit limits' });
    fireEvent.click(trigger);
    for (const label of ['Tool output — lines', 'Tool output — tokens', 'Question timeout', 'Memory recall — count', 'Memory recall — tokens', 'Goal turn budget', 'Goal safety ceiling', 'Live channel sessions', 'Sub-agent context']) {
      expect(screen.getByRole('slider', { name: label })).toBeTruthy();
    }
    expect(screen.getByText('5 min')).toBeTruthy();
    expect(screen.getByText('≈ 7.5k tokens')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('slider', { name: 'Memory recall — count' })).toBeNull());
  });

  it('autosaves the canonical count from a slider without a Save button', async () => {
    renderBrain();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit limits' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Memory recall — count' }), { key: 'ArrowRight' });
    await waitFor(
      () => expect((putBody as { brain: { limits: { memoryRecallCount: number } } })?.brain?.limits?.memoryRecallCount).toBe(7),
      { timeout: 3000 },
    );
  });

  // The daemon answers 6 to a slider moved to 7 — the state that used to leave the operator believing
  // the change stuck even though the server kept a different value.
  it('says which value the daemon kept when a save comes back clamped', async () => {
    renderBrain();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit limits' }));
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Memory recall — count' }), { key: 'ArrowRight' });
    await waitFor(
      () => expect(screen.getByText('Saved as 6 — the value you set was outside the allowed range.')).toBeTruthy(),
      { timeout: 3000 },
    );
  });
});
