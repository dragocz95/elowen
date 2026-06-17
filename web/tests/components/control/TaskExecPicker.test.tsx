import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { TaskExecPicker } from '../../../components/control/TaskExecPicker';
import { createWrapper } from '../../test-utils';

const server = setupServer(http.get('*/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5.4'], autopilot: { model: 'm', apiUrl: 'u', apiKeySet: false, notes: '' }, defaults: { exec: 'sonnet', autonomy: 'L3', maxSessions: 1 } })));
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('TaskExecPicker', () => {
  it('reflects the value and fires onChange', async () => {
    const onChange = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><TaskExecPicker value="sonnet" onChange={onChange} /></Wrapper>);
    const select = await screen.findByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('sonnet');
    fireEvent.change(select, { target: { value: 'codex:gpt-5.4' } });
    expect(onChange).toHaveBeenCalledWith('codex:gpt-5.4');
  });
});
