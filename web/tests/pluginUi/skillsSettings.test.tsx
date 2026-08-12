import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import { SkillsSettings } from '../../../plugins/skills/web-src/SkillsSettings';
import manifest from '../../../plugins/skills/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// The moved editor resolves everything through window.ElowenUiRuntime — install the REAL runtime,
// so this exercises the production contract the bundle runs against.
ensurePluginUiRuntime();

// View copy is served per-plugin by /plugins/ui; serving the REAL manifest en fallback keeps the
// assertions in lockstep with what production users see.
const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

const server = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'skills', url: '/plugins/skills/web/index.js', apiVersion: 1, nav: [], settings: [], strings }])),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const skillRow = (name: string, disableModelInvocation: boolean) =>
  ({ name, description: `${name} desc`, source: 'user', disableModelInvocation, version: null, content: `Body ${name}.` });
const list = [skillRow('alpha', false), skillRow('beta', false)];
const toggles = () => screen.getAllByRole('switch', { name: strings.disableModelInvocation });

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><SkillsSettings /></ToastProvider></Wrapper>);
};

describe('skills SkillsSettings (optimistic disclosure toggle)', () => {
  it('flips the clicked row immediately and disables only that row while the PATCH is in flight', async () => {
    let alphaDisabled = false;
    let resolvePatch!: () => void;
    const patchDone = new Promise<void>((r) => { resolvePatch = r; });
    server.use(
      http.get('*/api/plugins/skills/list', () => HttpResponse.json([skillRow('alpha', alphaDisabled), skillRow('beta', false)])),
      http.patch('*/api/plugins/skills/alpha', async () => { await patchDone; alphaDisabled = true; return HttpResponse.json({ ok: true }); }),
    );
    mount();

    await waitFor(() => expect(toggles()).toHaveLength(2));
    const [alpha, beta] = toggles();
    expect(alpha).not.toBeChecked();
    expect(beta).not.toBeChecked();

    fireEvent.click(alpha!);
    // Optimistic: alpha flips before the PATCH resolves, and only alpha is greyed out.
    await waitFor(() => expect(alpha).toBeChecked());
    expect(alpha).toBeDisabled();
    expect(beta).not.toBeDisabled();
    expect(beta).not.toBeChecked();

    // Once the server confirms (and the refetch lands the updated list), alpha stays on and re-enables.
    resolvePatch();
    await waitFor(() => expect(alpha).toBeEnabled());
    expect(alpha).toBeChecked();
  });

  it('rolls the toggle back when the PATCH fails', async () => {
    let rejectPatch!: () => void;
    const patchFail = new Promise<void>((r) => { rejectPatch = r; });
    server.use(
      http.get('*/api/plugins/skills/list', () => HttpResponse.json(list)),
      http.patch('*/api/plugins/skills/alpha', async () => { await patchFail; return HttpResponse.json({ error: 'boom' }, { status: 500 }); }),
    );
    mount();

    await waitFor(() => expect(toggles()).toHaveLength(2));
    const [alpha] = toggles();
    fireEvent.click(alpha!);
    await waitFor(() => expect(alpha).toBeChecked()); // optimistic flip, held while the PATCH is pending
    rejectPatch();
    await waitFor(() => expect(alpha).not.toBeChecked()); // rolled back on error
  });

  it('creates a skill through the editor form (list → add → save)', async () => {
    let created: unknown;
    server.use(
      http.get('*/api/plugins/skills/list', () => HttpResponse.json([])),
      http.post('*/api/plugins/skills', async ({ request }) => { created = await request.json(); return HttpResponse.json({ ok: true }, { status: 201 }); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: strings.add }));
    fireEvent.change(screen.getByPlaceholderText('deploy-checklist'), { target: { value: 'my-skill' } });
    const inputs = screen.getAllByRole('textbox');
    fireEvent.change(inputs[1]!, { target: { value: 'When to use it.' } });
    fireEvent.change(inputs[2]!, { target: { value: 'Do the thing.' } });
    fireEvent.click(screen.getByRole('button', { name: strings.save }));
    await waitFor(() => expect(created).toBeTruthy());
    expect(created).toEqual({ name: 'my-skill', description: 'When to use it.', content: 'Do the thing.', disableModelInvocation: false });
  });
});
