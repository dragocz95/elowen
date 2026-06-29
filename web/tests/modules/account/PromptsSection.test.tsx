import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { PromptsSection } from '../../../modules/account/PromptsSection';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const PROMPTS = [
  { name: 'worker', group: 'workers', vars: ['taskId'], jsonContract: false, default: 'DEFAULT worker {{taskId}}', override: null },
  { name: 'decision-question', group: 'overseer', vars: ['question'], jsonContract: true, default: 'DEFAULT dq', override: 'MY dq' },
];

function renderSection() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><PromptsSection /></ToastProvider></Wrapper>);
}

describe('PromptsSection', () => {
  it('renders grouped prompts with default/override + JSON badges and seeds the editor', async () => {
    server.use(http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)));
    renderSection();
    // Worker default → seeded with the default text; decision-question override → seeded with the override.
    expect(await screen.findByDisplayValue('DEFAULT worker {{taskId}}')).toBeTruthy();
    expect(screen.getByDisplayValue('MY dq')).toBeTruthy();
    expect(screen.getByText('Must return JSON')).toBeTruthy();
    expect(screen.getByText('Customized')).toBeTruthy(); // the overridden one
  });

  it('saves an edited prompt via PUT', async () => {
    let putBody: unknown = null;
    server.use(
      http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)),
      http.put('*/api/auth/me/prompts/worker', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ ok: true }); }),
    );
    renderSection();
    const ta = await screen.findByDisplayValue('DEFAULT worker {{taskId}}');
    fireEvent.change(ta, { target: { value: 'EDITED worker' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect((putBody as { content: string }).content).toBe('EDITED worker'));
  });

  it('resets an overridden prompt via DELETE', async () => {
    let deleted = false;
    server.use(
      http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)),
      http.delete('*/api/auth/me/prompts/decision-question', () => { deleted = true; return HttpResponse.json({ ok: true }); }),
    );
    renderSection();
    await screen.findByDisplayValue('MY dq');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(deleted).toBe(true));
  });
});
