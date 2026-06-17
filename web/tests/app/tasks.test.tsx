import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import TasksPage from '../../app/tasks/page';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

let spawnBody: unknown = null;
const server = setupServer(
  http.get('http://localhost:4400/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'Build', status: 'open' }])),
  http.post('http://localhost:4400/sessions', async ({ request }) => { spawnBody = await request.json(); return HttpResponse.json({ session: 'orca-A' }, { status: 201 }); }),
);
beforeAll(() => server.listen()); afterAll(() => server.close());

describe('TasksPage', () => {
  it('launches a task with the chosen executor', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><TasksPage /></ToastProvider></Wrapper>);
    await waitFor(() => expect(screen.getByText('orca-1')).toBeInTheDocument());
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: 'ollama/deepseek-v4-flash' } });
    await waitFor(() => expect(spawnBody).toMatchObject({ taskId: 'orca-1', exec: 'ollama/deepseek-v4-flash' }));
  });
});
