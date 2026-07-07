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

/** Mount the card against an msw-served permissions blob; returns the captured PATCH bodies. */
function mountWith(settings: PermissionSettings) {
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

const row = (pattern: string) =>
  screen.getByText(pattern).closest('li')! as HTMLElement;

describe('PermissionRulesCard', () => {
  it('lists bash rules from GET in stored order — an "Always allow" CLI pattern shows up as-is', async () => {
    mountWith({ tools: {}, bash: { '*': 'ask', 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    expect(await screen.findByText('git status*')).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getByRole('radiogroup').getAttribute('aria-label')))
      .toEqual(['*', 'git status*', 'rm *']);
    // Each row's active action reflects the stored value.
    expect(within(row('rm *')).getByRole('radio', { name: en.cli.permDeny }).getAttribute('aria-checked')).toBe('true');
    expect(within(row('git status*')).getByRole('radio', { name: en.cli.permAllow }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows the empty state when there are no bash rules', async () => {
    mountWith({ tools: {}, bash: {}, yolo: false });
    expect(await screen.findByText(en.cli.permEmpty)).toBeTruthy();
  });

  it('adding a rule PATCHes the whole bash map with the new pattern appended LAST', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow' }, yolo: false });
    await screen.findByText('git status*');
    fireEvent.change(screen.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: '  npm run build*  ' } });
    fireEvent.click(screen.getByRole('button', { name: en.cli.permAdd }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow', 'npm run build*': 'allow' } });
    expect(Object.keys((patches[0] as { bash: object }).bash)).toEqual(['git status*', 'npm run build*']);
    // The new rule renders immediately, appended after the existing one.
    const items = screen.getAllByRole('listitem');
    expect(within(items[1]!).getByText('npm run build*')).toBeTruthy();
  });

  it('the Add button stays disabled for an empty/whitespace pattern', async () => {
    const patches = mountWith({ tools: {}, bash: {}, yolo: false });
    await screen.findByText(en.cli.permEmpty);
    const add = screen.getByRole('button', { name: en.cli.permAdd });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: '   ' } });
    expect(add).toBeDisabled();
    expect(patches.length).toBe(0);
  });

  it('re-adding an existing pattern moves it to the END with the new action (last match wins)', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    await screen.findByText('git status*');
    fireEvent.change(screen.getByLabelText(en.cli.permPatternPlaceholder), { target: { value: 'git status*' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: en.cli.permNewAction })).getByRole('radio', { name: en.cli.permDeny }));
    fireEvent.click(screen.getByRole('button', { name: en.cli.permAdd }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(Object.keys((patches[0] as { bash: object }).bash)).toEqual(['rm *', 'git status*']);
    expect(patches[0]).toEqual({ bash: { 'rm *': 'deny', 'git status*': 'deny' } });
  });

  it('changing a row action PATCHes the map in place, order preserved', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'ask' }, yolo: false });
    await screen.findByText('rm *');
    fireEvent.click(within(row('rm *')).getByRole('radio', { name: en.cli.permDeny }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow', 'rm *': 'deny' } });
  });

  it('deleting a rule PATCHes the map without it', async () => {
    const patches = mountWith({ tools: {}, bash: { 'git status*': 'allow', 'rm *': 'deny' }, yolo: false });
    await screen.findByText('rm *');
    fireEvent.click(screen.getByRole('button', { name: `${en.cli.permDelete}: rm *` }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ bash: { 'git status*': 'allow' } });
  });

  it('hides the tools list entirely when the user has no tools rules', async () => {
    mountWith({ tools: {}, bash: { 'git status*': 'allow' }, yolo: false });
    await screen.findByText('git status*');
    expect(screen.queryByText(en.cli.permToolsTitle)).toBeNull();
  });

  it('shows editable tools rules when they exist — edits PATCH the tools map, never bash', async () => {
    const patches = mountWith({ tools: { write_file: 'allow' }, bash: { 'rm *': 'deny' }, yolo: false });
    await screen.findByText(en.cli.permToolsTitle);
    fireEvent.click(within(row('write_file')).getByRole('radio', { name: en.cli.permAsk }));
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0]).toEqual({ tools: { write_file: 'ask' } });
  });
});
