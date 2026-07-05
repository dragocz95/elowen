import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { DepPickerModal } from '../../../modules/tasks/DepPickerModal';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { Task } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 'T-1', project_id: 1, title: 't', type: 'task', status: 'open', priority: 'normal', created_at: '2026-01-01', ...over } as Task);

describe('DepPickerModal (auto-save)', () => {
  it('auto-saves the dependency set on toggle — no Save button — and Done closes', async () => {
    let patched: unknown = null;
    server.use(
      http.get('*/api/tasks/T-1/deps', () => HttpResponse.json([])),
      http.get('*/api/tasks', () => HttpResponse.json([task({ id: 'T-1' }), task({ id: 'T-2', title: 'blocker' })])),
      http.patch('*/api/tasks/T-1', async ({ request }) => { patched = await request.json(); return HttpResponse.json(task()); }),
    );
    const onClose = () => { closed = true; };
    let closed = false;
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><DepPickerModal task={task()} onClose={onClose} /></ToastProvider></Wrapper>);

    // The picker seeded from the server; pick the candidate blocker.
    const candidate = await screen.findByText('blocker');
    // No manual Save button — persistence is automatic.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(candidate);

    // Toggling auto-PATCHes the whole dep set.
    await waitFor(() => expect((patched as { deps: string[] })?.deps).toEqual(['T-2']));

    // Done closes the modal.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(closed).toBe(true);
  });
});
