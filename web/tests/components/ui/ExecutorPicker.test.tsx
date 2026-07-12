import { useState } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ExecutorPicker } from '../../../components/ui/ExecutorPicker';
import { createWrapper } from '../../test-utils';
import { onUnhandledRequest } from '../../msw';

const MODELS = [
  { label: 'Claude Sonnet 4.5', exec: 'sonnet' },
  { label: 'GPT-5 Codex', exec: 'codex:gpt-5' },
];

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5', 'elowen:anthropic::opus'] })),
  http.get('*/api/brain/models', () => HttpResponse.json([
    { provider: 'anthropic', providerLabel: 'Anthropic', model: 'Claude Opus', exec: 'elowen:anthropic::opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
  ])),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function Harness({ onChange, initial = '' }: { onChange: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <ExecutorPicker
      value={value}
      onChange={(next) => { setValue(next); onChange(next); }}
      models={MODELS}
      defaultLabel="Default executor"
    />
  );
}

function mount(props: React.ComponentProps<typeof Harness>) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><Harness {...props} /></Wrapper>);
}

describe('ExecutorPicker', () => {
  it('uses the shared selection summary instead of inline provider and model pills', async () => {
    mount({ onChange: vi.fn() });

    expect(await screen.findByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(screen.getByText('Default executor')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('selects a worker or Elowen AI model through the shared manage modal', async () => {
    const onChange = vi.fn();
    mount({ onChange });

    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    expect(await screen.findByRole('heading', { name: 'Claude Code' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Anthropic' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /GPT-5 Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('codex:gpt-5'));
  });
});
