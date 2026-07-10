import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  http.get('*/api/sessions', () => HttpResponse.json([])),
  http.get('*/api/tasks', () => HttpResponse.json([])),
  http.get('*/api/tasks/deps', () => HttpResponse.json([])),
  http.get('*/api/activity', () => HttpResponse.json([])),
  http.get('*/api/asks/pending', () => HttpResponse.json([pendingAsk])),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());

describe('NotificationBell', () => {
  it('links a pending ask to the decisions inbox even when there are no review escalations', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><NotificationBell /></Wrapper>);

    fireEvent.click(screen.getByRole('button', { name: 'Notifications' }));

    const inbox = await screen.findByRole('link', { name: /Escalations \(1\).*Choose the database/ });
    expect(inbox).toHaveAttribute('href', '/escalations');
    expect(screen.queryByText('No agents waiting for approval.')).not.toBeInTheDocument();
  });
});
