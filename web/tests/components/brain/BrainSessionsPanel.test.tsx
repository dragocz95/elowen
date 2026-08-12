import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { BrainSessionsPanel } from '../../../components/brain/BrainSessionsPanel';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';

// Moved from tests/pluginUi/agentsSessions.test.tsx when the register left the agents plugin's
// Sessions page: the panel is core data and now renders from the Chat page's register modal.
let admin = false;
const conversations = Array.from({ length: 13 }, (_, index) => ({
  id: `brain-${index + 1}`,
  title: `Conversation ${index + 1}`,
  model: 'gpt-5.5',
  updated_at: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  running: index === 0,
  active: index === 0,
}));
const server = setupServer(
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'user', is_admin: admin } })),
  http.get('*/api/brain/sessions', () => HttpResponse.json(conversations)),
  http.get('*/api/brain/managed-sessions', () => HttpResponse.json(conversations.map((session) => ({ ...session, kind: 'conversation', tokens: 1200 })) )),
);
beforeEach(() => { admin = false; localStorage.clear(); });
beforeAll(() => server.listen()); afterAll(() => server.close());

function renderPanel() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainSessionsPanel /></ToastProvider></Wrapper>);
}

describe('BrainSessionsPanel (conversation register)', () => {
  it('renders conversations as full-width rows with pagination', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());
    expect(screen.getByTestId('brain-sessions-list')).toHaveAttribute('role', 'list');
    expect(screen.getByRole('button', { name: 'Conversation 1: Actions' })).toBeInTheDocument();
    expect(screen.getByTestId('brain-sessions-list').children).toHaveLength(12);
    expect(screen.queryByText('Conversation 13')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Conversation 13')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Conversation 1')).not.toBeInTheDocument());
  });

  it('offers the conversation row actions from right click', async () => {
    renderPanel();
    await screen.findByText('Conversation 1');

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open in web chat: Conversation 1' }));

    expect(screen.getByRole('menuitem', { name: 'Download as HTML' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Download as JSONL' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('uses the shared table heading and keeps Delete all in its action zone', async () => {
    admin = true;
    renderPanel();
    await waitFor(() => expect(screen.getByText('Conversation 1')).toBeInTheDocument());

    const toolbar = screen.getByTestId('brain-sessions-toolbar');
    expect(toolbar).toHaveClass('control-surface-toolbar');
    expect(screen.getByTestId('brain-sessions-list').closest('.control-surface-register')).toBeInTheDocument();
    expect(within(toolbar).getByRole('heading', { name: 'Conversations' })).toHaveClass('text-base');
    expect(within(toolbar).getByRole('button', { name: 'Delete all' })).toHaveClass('spatial-inline-action');
  });
});
