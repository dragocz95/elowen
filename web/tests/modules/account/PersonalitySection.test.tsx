import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { PersonalitySection } from '../../../modules/account/PersonalitySection';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { CliSettings } from '../../../lib/types';

// Monaco is browser-only (web workers) and never mounts under jsdom; stub it with a plain textarea that
// forwards value/onChange so the body field is exercisable without loading the real editor.
vi.mock('../../../modules/projects/editor/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="personality-body" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  MonacoDiffEditor: () => null,
}));

const settings: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', thinkingLevel: 'medium',
  autoCompact: true, autoCompactAt: 0, advisorStyle: 'concise', personalityBody: '',
  discordUserId: '', whatsappNumber: '', autoRecall: true, autoSave: true,
};

let lastPatch: Partial<CliSettings> | null = null;

const server = setupServer(
  http.get('*/api/auth/me/cli-settings', () => HttpResponse.json(settings)),
  http.patch('*/api/auth/me/cli-settings', async ({ request }) => {
    lastPatch = (await request.json()) as Partial<CliSettings>;
    return HttpResponse.json({ ...settings, ...lastPatch });
  }),
);
beforeAll(() => server.listen()); afterEach(() => { server.resetHandlers(); lastPatch = null; }); afterAll(() => server.close());

describe('PersonalitySection', () => {
  it('renders the pills and opens the body editor in a modal', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><PersonalitySection /></ToastProvider>, { wrapper });

    expect(await screen.findByRole('button', { name: 'Professional' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Friendly' })).toBeInTheDocument();
    // Empty body → no inline editor; the Monaco editor only mounts inside the modal.
    expect(screen.queryByLabelText('personality-body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add instructions' }));
    expect(await screen.findByLabelText('personality-body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('autosaves advisorStyle and personalityBody together in one PATCH', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><PersonalitySection /></ToastProvider>, { wrapper });

    // The server style is 'concise' — wait for the seed to land (that pill becomes pressed) before
    // editing, otherwise the seeding effect would overwrite the edits.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Concise' })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByRole('button', { name: 'Friendly' }));
    // Open the modal to reach the body editor, then edit it.
    fireEvent.click(screen.getByRole('button', { name: 'Add instructions' }));
    fireEvent.change(await screen.findByLabelText('personality-body'), { target: { value: 'Be warm.' } });

    await waitFor(() => expect(lastPatch).not.toBeNull());
    await waitFor(() => expect(lastPatch).toEqual({ advisorStyle: 'friendly', personalityBody: 'Be warm.' }));
  });
});
