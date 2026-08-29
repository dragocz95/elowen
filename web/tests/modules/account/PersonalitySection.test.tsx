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
vi.mock('../../../lib/monaco/monacoLoader', () => ({
  MonacoEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="user-instructions" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  MonacoDiffEditor: () => null,
}));

const settings: CliSettings = {
  model: '', modelProvider: '', visionModel: '', visionModelProvider: '', compactModel: '', compactModelProvider: '', thinkingLevel: 'medium',
  autoCompact: true, autoCompactAt: 0, autoCompactAtByModel: {}, advisorStyle: 'concise', userInstructions: '',
  discordUserId: '', whatsappNumber: '', autoRecall: true, autoLiveRecall: true, autoSave: true,
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

describe('PersonalitySection — error state', () => {
  it('shows a retryable error instead of an editor that can never save', async () => {
    server.use(http.get('*/api/auth/me/cli-settings', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
    const { wrapper } = createWrapper();
    render(<ToastProvider><PersonalitySection /></ToastProvider>, { wrapper });

    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // No editor form (style picker / body field) must render while the load has failed.
    expect(screen.queryByRole('button', { name: 'Communication style' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agent instructions' })).not.toBeInTheDocument();

    server.use(http.get('*/api/auth/me/cli-settings', () => HttpResponse.json(settings)));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Concise')).toBeInTheDocument();
  });
});

describe('PersonalitySection', () => {
  it('shows the current style as a chip and opens the body editor in a drawer', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><PersonalitySection /></ToastProvider>, { wrapper });

    // The style renders as a chip of the seeded pick; the full choice opens in the shared picker.
    expect(await screen.findByText('Concise')).toBeInTheDocument();
    // Empty body → no inline editor; the Monaco editor only mounts inside the drawer.
    expect(screen.queryByLabelText('user-instructions')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Agent instructions' }));
    expect(await screen.findByLabelText('user-instructions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('autosaves advisorStyle and userInstructions together in one PATCH', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><PersonalitySection /></ToastProvider>, { wrapper });

    // The server style is 'concise' — wait for the seed to land (the chip shows it) before editing,
    // otherwise the seeding effect would overwrite the edits.
    expect(await screen.findByText('Concise')).toBeInTheDocument();
    // Pick a new style in the picker. The trigger is named for the field, so the style row and the
    // instructions row beside it no longer offer a screen reader two identically named buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Communication style' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Friendly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    // Open the drawer to reach the body editor, then edit it.
    fireEvent.click(screen.getByRole('button', { name: 'Agent instructions' }));
    fireEvent.change(await screen.findByLabelText('user-instructions'), { target: { value: 'Be warm.' } });

    await waitFor(() => expect(lastPatch).not.toBeNull());
    await waitFor(() => expect(lastPatch).toEqual({ advisorStyle: 'friendly', userInstructions: 'Be warm.' }));
  });
});
