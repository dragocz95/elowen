import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { PermissionRulesCard } from '../../../modules/account/PermissionRulesCard';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { PermissionSettings } from '../../../lib/types';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

/** Mount the card against an msw-served permissions blob; returns the captured PATCH bodies. The card
 *  only reads/writes the rule maps, so the blob's other fields ride server defaults. */
function mountWith(rules: Omit<PermissionSettings, 'yolo' | 'unattendedAsks'> & Partial<PermissionSettings>) {
  const settings: PermissionSettings = { yolo: false, unattendedAsks: 'allow', ...rules };
  const patches: unknown[] = [];
  server.use(
    http.get('*/api/auth/me/permissions', () => HttpResponse.json(settings)),
    http.patch('*/api/auth/me/permissions', async ({ request }) => {
      patches.push(await request.json());
      return HttpResponse.json(settings);
    }),
  );
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><PermissionRulesCard /></ToastProvider></Wrapper>);
  return patches;
}

/** The row shows only summary chips; the editor lives in the side drawer behind the manage button.
 *  Returns queries scoped to the drawer so pattern texts don't collide with the summary chips. */
async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: en.cli.permTitle }));
  return within(await screen.findByRole('dialog'));
}

type Scoped = Awaited<ReturnType<typeof openEditor>>;
const row = (d: Scoped, pattern: string) => within(d.getByText(pattern).closest('li')! as HTMLElement);

describe('PermissionRulesCard', () => {
  it('lists bash rules from GET in stored order — an "Always allow" CLI pattern shows up as-is', async () => {
    mountWith({ tools: {}, bash: { '*': 'ask', 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    const d = await openEditor();
    expect(d.getByText('git status*')).toBeTruthy();
    const items = d.getAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('radiogroup').getAttribute('aria-label')))
      .toEqual(['*', 'git status*', 'rm *']);
    // Each row's active action reflects the stored value.
    expect(row(d, 'rm *').getByRole('radio', { name: en.cli.permDeny }).getAttribute('aria-checked')).toBe('true');
    expect(row(d, 'git status*').getByRole('radio', { name: en.cli.permAllow }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the empty state when there are no bash rules', async () => {
    mountWith({ tools: {}, bash: {}, yolo: false });
    const d = await openEditor();
    expect(d.getByText(en.cli.permEmpty)).toBeTruthy();
  });

  it('adding a rule PATCHes the whole bash map with the new pattern appended LAST', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow' }, yolo: false });
    const d = await openEditor();
    fireEvent.change(d.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: '  npm run build*  ' } });
    fireEvent.click(d.getByRole('button', { name: en.cli.permAdd }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow', 'npm run build*': 'allow' } });
    expect(Object.keys((patches[0] as { bash: object }).bash)).toEqual(['git status*', 'npm run build*']);
    // The new rule renders immediately, appended after the existing one.
    const items = d.getAllByRole('listitem');
    expect(within(items[1]!).getByText('npm run build*')).toBeTruthy();
  });

  it('the Add button stays disabled for an empty/whitespace pattern', async () => {
    const patches = mountWith({ tools: {}, bash: {}, yolo: false });
    const d = await openEditor();
    const add = d.getByRole('button', { name: en.cli.permAdd });
    expect(add).toBeDisabled();
    fireEvent.change(d.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: '   ' } });
    expect(add).toBeDisabled();
    expect(patches.length).toBe(0);
  });

  it('re-adding an existing pattern moves it to the END with the new action (last match wins)', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    const d = await openEditor();
    fireEvent.change(d.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: 'git status*' } });
    fireEvent.click(within(d.getByRole('radiogroup', { name: en.cli.permNewAction })).getByRole('radio', { name: en.cli.permDeny }));
    fireEvent.click(d.getByRole('button', { name: en.cli.permAdd }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(Object.keys((patches[0] as { bash: object }).bash)).toEqual(['rm *', 'git status*']);
    expect(patches[0]).toEqual({ bash: { 'rm *': 'deny', 'git status*': 'deny' } });
  });

  it('changing a row action PATCHes the map in place, order preserved', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'ask' }, yolo: false });
    const d = await openEditor();
    fireEvent.click(row(d, 'rm *').getByRole('radio', { name: en.cli.permDeny }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow', 'rm *': 'deny' } });
  });

  it('deleting a rule PATCHes the map without it', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    const d = await openEditor();
    fireEvent.click(d.getByRole('button', { name: `${en.cli.permDelete}: rm *` }));
    expect(patches.length).toBe(0);
    // The ConfirmDialog stacks above the drawer, so its confirm button is queried screen-wide.
    fireEvent.click(screen.getByRole('button', { name: en.cli.permDelete }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow' } });
  });

  it('hides the tools list entirely when the user has no tools rules', async () => {
    mountWith({ tools: {}, bash: { 'git status*': 'allow' }, yolo: false });
    const d = await openEditor();
    expect(d.queryByText(en.cli.permToolsTitle)).toBeNull();
  });

  it('shows editable tools rules when they exist — edits PATCH the tools map, never bash', async () => {
    const patches = mountWith({ tools: { Write: 'allow' }, bash: { 'rm *': 'deny' }, yolo: false });
    const d = await openEditor();
    expect(d.getByText(en.cli.permToolsTitle)).toBeTruthy();
    fireEvent.click(row(d, 'Write').getByRole('radio', { name: en.cli.permAsk }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ tools: { Write: 'ask' } });
  });

  it('reconciles a phantom rule away when the save fails (refetch on error)', async () => {
    const settings: PermissionSettings = { yolo: false, unattendedAsks: 'allow', tools: {}, bash: { 'git status*': 'allow' } };
    server.use(
      http.get('*/api/auth/me/permissions', () => HttpResponse.json(settings)),
      http.patch('*/api/auth/me/permissions', () => new HttpResponse(null, { status: 500 })),
    );
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><PermissionRulesCard /></ToastProvider></Wrapper>);
    const d = await openEditor();

    fireEvent.change(d.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: 'npm run build*' } });
    fireEvent.click(d.getByRole('button', { name: en.cli.permAdd }));
    // The optimistic row appears immediately...
    expect(await d.findByText('npm run build*')).toBeTruthy();
    // ...then the failed save triggers a refetch that reseeds the list back to the server truth,
    // so the non-persisted rule vanishes — no phantom left behind. The real server rule stays.
    await waitFor(() => expect(d.queryByText('npm run build*')).toBeNull());
    expect(d.getByText('git status*')).toBeTruthy();
  });
});
