import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { NotificationBell } from '../../../components/ui/NotificationBell';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

const pendingAsk = {
  askId: 'ask-1',
  taskId: 'task-1',
  question: 'Postgres or SQLite?',
  since: 0,
  title: 'Choose the database',
  epicId: null,
  projectId: 1,
};

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'agents', url: '/plugins/agents/web/index.js', apiVersion: 1, nav: [], settings: [] }])),
  http.get('*/api/sessions', () => HttpResponse.json([])),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  http.get('*/api/tasks/deps', () => HttpResponse.json([])),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/asks/pending', () => HttpResponse.json([pendingAsk])),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('NotificationBell', () => {
  it('links a pending ask to the decisions inbox even when there are no review escalations', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><NotificationBell /></Wrapper>);

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    const inbox = await screen.findByRole('link', { name: /Escalations \(1\).*Choose the database/ });
    expect(inbox).toHaveAttribute('href', '/p/agents/escalations');
    expect(screen.queryByText('No agents waiting for approval.')).not.toBeInTheDocument();
  });

  it('shows NO decisions inbox (count 0) when the agents plugin is absent', async () => {
    // The inbox link targets /p/agents/escalations — with the plugin off it would land on a plugin-404
    // page, so the bell must not glow over stale escalation data.
    server.use(http.get('*/api/plugins/ui', () => HttpResponse.json([])));
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><NotificationBell /></Wrapper>);

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText('No agents waiting for approval.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Escalations/ })).not.toBeInTheDocument();
  });
});
