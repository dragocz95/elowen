import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { PromptsSection } from '../../../modules/account/PromptsSection';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

// Monaco is browser-only (web workers) — swap it for a plain textarea in jsdom.
vi.mock('../../../modules/projects/editor/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="prompt-editor" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
vi.mock('../../../modules/projects/editor/oledTheme', () => ({ defineEditorThemes: () => {} }));

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const PROMPTS = [
  { name: 'worker', group: 'workers', vars: ['taskId'], jsonContract: false, default: 'DEFAULT worker {{taskId}}', override: null },
  { name: 'decision-question', group: 'overseer', vars: ['question'], jsonContract: true, default: 'DEFAULT dq', override: 'MY dq' },
  { name: 'advisor', group: 'advisor', vars: ['userName'], jsonContract: false, appendOnly: true, default: '', override: null },
];

function renderSection() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><PromptsSection /></ToastProvider></Wrapper>);
}

describe('PromptsSection', () => {
  it('renders grouped prompt rows with badges and opens the editor modal', async () => {
    server.use(http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)));
    renderSection();
    expect(await screen.findByText('worker')).toBeTruthy();
    expect(screen.getByText('Must return JSON')).toBeTruthy();
    expect(screen.getByText('Customized')).toBeTruthy(); // the overridden one
    // Row click opens the modal seeded with the effective text (override else default).
    fireEvent.click(screen.getByText('worker'));
    expect(await screen.findByDisplayValue('DEFAULT worker {{taskId}}')).toBeTruthy();
  });

  it('saves an edited prompt via PUT', async () => {
    let putBody: unknown = null;
    server.use(
      http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)),
      http.put('*/api/auth/me/prompts/worker', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ ok: true }); }),
    );
    renderSection();
    fireEvent.click(await screen.findByText('worker'));
    const ta = await screen.findByDisplayValue('DEFAULT worker {{taskId}}');
    fireEvent.change(ta, { target: { value: 'EDITED worker' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect((putBody as { content: string }).content).toBe('EDITED worker'));
  });

  it('resets an overridden prompt via DELETE', async () => {
    let deleted = false;
    server.use(
      http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)),
      http.delete('*/api/auth/me/prompts/decision-question', () => { deleted = true; return HttpResponse.json({ ok: true }); }),
    );
    renderSection();
    fireEvent.click(await screen.findByText('decision-question'));
    await screen.findByDisplayValue('MY dq');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('advisor is append-only: a plain textarea for own preferences, no Monaco, PUT saves the text', async () => {
    let putBody: unknown = null;
    server.use(
      http.get('*/api/auth/me/prompts', () => HttpResponse.json(PROMPTS)),
      http.put('*/api/auth/me/prompts/advisor', async ({ request }) => { putBody = await request.json(); return HttpResponse.json({ ok: true }); }),
    );
    renderSection();
    fireEvent.click(await screen.findByText('Orca — your preferences'));
    // Append-only editor is a textarea (the managed system prompt is never shown).
    const box = await screen.findByPlaceholderText(/Always answer in Czech/);
    expect(screen.queryByTestId('monaco')).toBeNull();
    fireEvent.change(box, { target: { value: 'Be brief.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(putBody).toEqual({ content: 'Be brief.' }));
  });
});
