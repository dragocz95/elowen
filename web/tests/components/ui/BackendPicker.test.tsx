import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { BackendPicker } from '../../../components/ui/BackendPicker';
import { createWrapper } from '../../test-utils';

// Worker presets fed to the picker + the Elowen AI (brain) catalog served over the network. The
// allow-list gates which brain models appear — mirrors ExecutorPicker's `kind='all'` rule.
const MODELS = [
  { label: 'Claude Sonnet 4.5', exec: 'sonnet' },
  { label: 'GPT-5 Codex', exec: 'codex:gpt-5' },
];
const BRAIN = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'Claude Opus', exec: 'elowen:anthropic::opus', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
];

// The SAME model name reachable through two different providers — a real configuration (an OAuth
// account and a relay both serving `claude-opus-5`). Their identities differ, their display names do not.
const COLLIDING_BRAIN = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-5', exec: 'elowen:anthropic/claude-opus-5', legacyExec: 'elowen:anthropic/claude-opus-5', program: 'elowen', source: 'oauth', contextWindow: 200000, contextWindowSet: false },
  { provider: 'relay', providerLabel: 'Relay', model: 'claude-opus-5', exec: 'elowen:relay/claude-opus-5', legacyExec: 'elowen:relay/claude-opus-5', program: 'elowen', source: 'relay', contextWindow: 200000, contextWindowSet: false },
];

const server = setupServer(
  http.get('*/api/config', () => HttpResponse.json({ allowedExecs: ['sonnet', 'codex:gpt-5', 'elowen:anthropic::opus'] })),
  http.get('*/api/brain/models', () => HttpResponse.json(BRAIN)),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

/** Controlled harness so a pick updates `value` and we can inspect the `onChange` argument. */
function Harness({ onChange, initial = '', allowRelay = false, kind = 'all' }: { onChange: (v: string) => void; initial?: string; allowRelay?: boolean; kind?: 'all' | 'brain' }) {
  const [value, setValue] = useState(initial);
  return (
    <BackendPicker
      value={value}
      onChange={(v) => { setValue(v); onChange(v); }}
      models={MODELS}
      relayLabel="Relay (model via API)"
      allowRelay={allowRelay}
      kind={kind}
    />
  );
}

function mount(props: Parameters<typeof Harness>[0]) {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><Harness {...props} /></Wrapper>);
}

describe('BackendPicker', () => {
  it('renders as a summary with a Manage button; empty value shows the relay label', async () => {
    mount({ onChange: vi.fn() });
    // No pill rows — just a compact summary + Manage affordance.
    expect(await screen.findByRole('button', { name: 'Manage' })).toBeTruthy();
    expect(screen.getByText('Relay (model via API)')).toBeTruthy();
  });

  it('opens the modal with worker + Elowen AI groups, group logos and per-row icons', async () => {
    mount({ onChange: vi.fn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));

    // Workers group: engine logo on the header, brand icon on the row.
    const workers = await screen.findByRole('heading', { name: 'Claude Code' });
    expect(workers.querySelector('img')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Claude Sonnet 4.5/ }).querySelector('img')).toBeTruthy();

    // One "Elowen AI" group carrying the Elowen mark; the underlying provider + auth source ride the row
    // as badges instead of splitting the brain models into per-provider groups.
    const elowen = await screen.findByRole('heading', { name: 'Elowen AI' });
    expect(elowen.querySelector('img')).toBeTruthy();
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('OAuth')).toBeTruthy();
  });

  it('single-select: clicking a row and saving fires onChange with that exec', async () => {
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /GPT-5 Codex/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('codex:gpt-5'));
  });

  it('single-select picks an Elowen AI brain model by its exec', async () => {
    const onChange = vi.fn();
    mount({ onChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    fireEvent.click(await screen.findByRole('button', { name: /Claude Opus/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('elowen:anthropic::opus'));
  });

  it('when allowRelay, a pinned relay row lets the user clear the pick to relay', async () => {
    const onChange = vi.fn();
    mount({ onChange, initial: 'sonnet', allowRelay: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
    // The pinned relay row (empty exec) sits above the groups; picking it saves ''.
    fireEvent.click(await screen.findByRole('button', { name: 'Relay (model via API)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
  });

  // The row id is the composite identity, the row label is the bare model name. If the two are ever
  // collapsed (id := the displayed name), these two models merge into one ambiguous row and a saved
  // value stops matching any row — the "unknown model" symptom this split exists to prevent.
  describe('same model name from two providers', () => {
    const useCollidingCatalog = () => server.use(
      http.get('*/api/config', () => HttpResponse.json({ allowedExecs: COLLIDING_BRAIN.map((m) => m.exec) })),
      http.get('*/api/brain/models', () => HttpResponse.json(COLLIDING_BRAIN)),
    );

    it('stays two distinct, provider-badged rows', async () => {
      useCollidingCatalog();
      mount({ onChange: vi.fn(), kind: 'brain' });
      fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      const rows = await screen.findAllByRole('button', { name: /claude-opus-5/ });
      expect(rows).toHaveLength(2);
      // …and each one names the provider it belongs to, so they are telling apart in the UI too.
      expect(rows[0]!.textContent).toContain('Anthropic');
      expect(rows[1]!.textContent).toContain('Relay');
    });

    it('saves the identity of the row that was picked, not the shared display name', async () => {
      useCollidingCatalog();
      const onChange = vi.fn();
      mount({ onChange, kind: 'brain' });
      fireEvent.click(await screen.findByRole('button', { name: 'Manage' }));
      const rows = await screen.findAllByRole('button', { name: /claude-opus-5/ });
      fireEvent.click(rows[1]!); // the relay one
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith('elowen:relay/claude-opus-5'));
    });

    it('shows the saved value as its own row instead of an unknown pick', async () => {
      useCollidingCatalog();
      mount({ onChange: vi.fn(), initial: 'elowen:relay/claude-opus-5', kind: 'brain' });
      // Summary renders the clean model name — the raw spec would mean the value matched no row.
      expect(await screen.findByText('claude-opus-5')).toBeTruthy();
      expect(screen.queryByText('elowen:relay/claude-opus-5')).toBeNull();
    });
  });

  it('preserves a saved-but-unknown exec as a pinned, selectable row', async () => {
    const onChange = vi.fn();
    mount({ onChange, initial: 'removed:legacy-model' });
    // The summary surfaces the unknown value so it never silently vanishes.
    expect(await screen.findByText('removed:legacy-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    // Re-picking it round-trips the same exec on save.
    fireEvent.click(await screen.findByRole('button', { name: /removed:legacy-model/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('removed:legacy-model'));
  });
});
