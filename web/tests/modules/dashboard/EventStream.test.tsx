import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { EventStream } from '../../../modules/dashboard/EventStream';
import { createWrapper } from '../../test-utils';

const EVENTS = [
  { id: 5, ts: '2026-06-30 12:00:00', type: 'review', target: 't1', detail: 'approved: lgtm', project_id: 1, label: 'Ship it' },
  { id: 4, ts: '2026-06-30 11:59:00', type: 'review', target: 't2', detail: 'escalated: unsure', project_id: 1, label: 'Risky change' },
  { id: 3, ts: '2026-06-30 11:58:00', type: 'mission', target: 'm-e', detail: 'active', project_id: 1, label: 'Big mission' },
  { id: 2, ts: '2026-06-30 11:57:00', type: 'task', target: 't3', detail: 'closed', project_id: 1, label: 'Fix the bug' },
  { id: 1, ts: '2026-06-30 11:56:00', type: 'signal', target: 'orca-Iris', detail: 'working', project_id: 1, label: 'noise' },
];

let payload = EVENTS;
const server = setupServer(
  http.get('*/api/activity', () => HttpResponse.json(payload)),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => { server.resetHandlers(); payload = EVENTS; }); afterAll(() => server.close());

describe('EventStream', () => {
  it('renders each event as a verb + subject, newest first, and drops signal noise', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EventStream /></Wrapper>);
    expect(await screen.findByText('Approved')).toBeTruthy();
    expect(screen.getByText('Ship it')).toBeTruthy();
    expect(screen.getByText('Needs approval')).toBeTruthy();
    expect(screen.getByText('Mission started')).toBeTruthy();
    expect(screen.getByText('Task done')).toBeTruthy();
    // The signal event is filtered out — its label never renders.
    expect(screen.queryByText('noise')).toBeNull();
  });

  it('shows the empty state when there is no activity', async () => {
    payload = [];
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><EventStream /></Wrapper>);
    expect(await screen.findByText('No activity yet.')).toBeTruthy();
  });
});
