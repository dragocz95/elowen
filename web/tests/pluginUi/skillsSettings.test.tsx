import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  // The register labels the owner column against the signed-in account, so the page reads /auth/me.
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 7, username: 'filip', is_admin: true } })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

const skillRow = (name: string, disableModelInvocation: boolean, owner: number | null = null, canDelete = true) =>
  ({ name, description: `${name} desc`, source: 'user', owner, canDelete, disableModelInvocation, version: null, content: `Body ${name}.` });
const list = [skillRow('alpha', false), skillRow('beta', false)];
const toggles = () => screen.getAllByRole('switch', { name: strings.disableModelInvocation });

const mount = (surface: 'page' | 'deck' = 'deck') => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><SkillsSettings surface={surface} /></ToastProvider></Wrapper>);
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
    fireEvent.click((await screen.findAllByRole('button', { name: strings.add }))[0]!);
    // The form lives in the workspace detail drawer; the page behind it has a search box of its own.
    const form = within(await screen.findByRole('dialog'));
    fireEvent.change(form.getByPlaceholderText('deploy-checklist'), { target: { value: 'my-skill' } });
    const inputs = form.getAllByRole('textbox');
    fireEvent.change(inputs[1]!, { target: { value: 'When to use it.' } });
    fireEvent.change(inputs[2]!, { target: { value: 'Do the thing.' } });
    fireEvent.click(form.getByRole('button', { name: strings.save }));
    await waitFor(() => expect(created).toBeTruthy());
    // `owner` is a query param selecting the target set, never part of the written skill.
    expect(created).toEqual({ name: 'my-skill', description: 'When to use it.', content: 'Do the thing.', disableModelInvocation: false });
  });

  // Per-user skills make the NAME ambiguous: an account's own skill and an instance-wide one may both
  // be called "alpha". The register keys rows by name AND owner — keying on the name alone made one row
  // highlight (and offer to delete) the other.
  it('separates same-named skills by owner and filters by scope', async () => {
    server.use(http.get('*/api/plugins/skills/list', () => HttpResponse.json([
      skillRow('alpha', false, null), // instance-wide
      skillRow('alpha', false, 7),    // mine
      skillRow('gamma', false, 9),    // someone else's (admin sees it)
    ])));
    const mounted = mount();

    await waitFor(() => expect(screen.getAllByText('alpha')).toHaveLength(2));
    expect(screen.getAllByText(strings.ownerInstance).length).toBeGreaterThan(0);
    expect(screen.getAllByText(strings.ownerMine).length).toBeGreaterThan(0);
    expect(screen.getByText('#9')).toBeInTheDocument();

    // Opening MY alpha must select exactly one row, not both.
    fireEvent.click(screen.getByRole('radio', { name: strings.scopeMine }));
    await waitFor(() => expect(screen.getAllByText('alpha')).toHaveLength(1));
    expect(screen.queryByText('gamma')).toBeNull();

    // Back to everything, then open MY alpha: exactly one row may light up, not both namesakes.
    // ONE "all" radio: an asset type with ownership scopes shows only that filter, because the coarse
    // source filter beside it would answer the same question twice (and offer "Built-in" in both).
    fireEvent.click(screen.getByRole('radio', { name: strings.scopeAll }));
    await waitFor(() => expect(screen.getAllByText('alpha')).toHaveLength(2));
    fireEvent.click(screen.getAllByText('alpha')[1]!);
    await screen.findByRole('dialog');
    expect(mounted.container.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });

  // The daemon decides who may write which skill; a row this caller cannot write must not offer controls
  // whose request would come back 403 — but it is still a CUSTOM skill, not a built-in one.
  it('shows a skill the caller may not write as read-only, without calling it built-in', async () => {
    server.use(http.get('*/api/plugins/skills/list', () => HttpResponse.json([
      skillRow('shared-one', false, null, false), // instance-wide, seen by a non-admin
      skillRow('mine', false, 7, true),
    ])));
    const mounted = mount();

    await screen.findByText('shared-one');
    // One delete button and one editable name button: the read-only row offers neither.
    expect(screen.getAllByRole('button', { name: strings.remove })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'mine' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'shared-one' })).toBeNull();
    // Provenance is not editability: both rows are user-defined skills.
    expect(mounted.container.textContent).not.toContain(strings.badgeBundled);
  });

  // The same component serves the Settings deck and its own page. On a page it wears the SAME spatial
  // workspace the built-in pages wear — hero, metrics, control surface — while in the deck the panel
  // around it already names the section, so a hero there would be noise. Getting this wrong is what
  // made the plugin pages read as fragments pasted onto an empty screen.
  it('wears the spatial workspace on a page and stays bare inside the Settings deck', async () => {
    server.use(http.get('*/api/plugins/skills/list', () => HttpResponse.json(list)));

    const page = mount('page');
    await waitFor(() => expect(page.container.querySelector('.spatial-workspace-hero h1')?.textContent).toBe(strings.title));
    expect(page.container.querySelector('.workspace-header__eyebrow')?.textContent).toBeTruthy();
    expect(page.container.querySelector('.spatial-workspace-hero__metrics')?.textContent).toBeTruthy();
    // The register is the same control surface the built-in workspaces use.
    expect(page.container.querySelector('[data-control-surface]')).not.toBeNull();
    page.unmount();

    const deck = mount('deck');
    await waitFor(() => expect(deck.container.querySelector('[data-control-surface]')).not.toBeNull());
    expect(deck.container.querySelector('.spatial-workspace-hero')).toBeNull();
  });
});
