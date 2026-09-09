import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
let pathname = '/dash';
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { Shell } from '../../components/shell/Shell';

class FakeES { onmessage = null; addEventListener() {} close() {} constructor(public url: string) {} }
(globalThis as unknown as { EventSource: typeof FakeES }).EventSource = FakeES;

/** `editor` declares itself a workbench in its manifest; `skills` says nothing and stays a document. */
const listing = [
  { name: 'editor', url: '/plugins/editor/web/a.js', apiVersion: 16, layout: 'workbench', nav: [{ label: 'Editor', route: '' }], settings: [] },
  { name: 'skills', url: '/plugins/skills/web/b.js', apiVersion: 16, nav: [{ label: 'Skills', route: '' }], settings: [] },
];

const server = setupServer(
  http.get('*/api/health', () => HttpResponse.json({ ok: true })),
  http.get('*/api/auth/me/nav-settings', () => HttpResponse.json({ hidden: [], order: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 1, username: 'admin' } })),
  http.get('*/api/plugins/ui', () => HttpResponse.json(listing)),
  // /chat mounts the chat provider, which reaches for these on open.
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);
beforeAll(() => server.listen({ onUnhandledRequest })); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

/** The one frame every route is read inside: `.shell-content`'s parent (components/shell/Shell.tsx).
 *  Unmounts before returning so a case may walk several routes without two shells in one document. */
async function frame(route: string): Promise<HTMLElement> {
  pathname = route;
  const view = render(<Shell><span data-testid="page-body">body</span></Shell>);
  const body = await within(view.container).findByTestId('page-body');
  // The measure comes from the plugin listing, so wait for the listing to be in — the editor's own world
  // in the navigation is the proof it landed. Without this the assertion races the first paint, where
  // every route is still a document.
  await within(view.container).findByRole('link', { name: 'Editor' });
  const found = body.closest('.shell-content')?.parentElement ?? null;
  expect(found, `no shell frame around ${route}`).not.toBeNull();
  view.unmount();
  return found as HTMLElement;
}
const frameClass = async (route: string): Promise<string> => (await frame(route)).className;

// A plugin page is not a document. The editor is a workbench — a file tree, an editor pane and a diff
// beside each other — and reading it at the page measure wastes a third of a wide display. Which measure
// a page gets is DECLARED by the plugin manifest (`web.layout`) and applied by the shell, so the plugin
// never has to out-specify the host's frame from its own stylesheet, which is impossible anyway.
describe('the shell reads each route at its declared measure', () => {
  it('gives a plugin page that declares `workbench` the wide frame', async () => {
    const className = await frameClass('/p/editor');
    expect(className).toContain('max-w-[var(--workbench-max)]');
    expect(className).not.toContain('max-w-[var(--content-max)]');
  });

  it('keeps a plugin page that declares nothing at the ordinary page measure', async () => {
    const className = await frameClass('/p/skills');
    expect(className).toContain('max-w-[var(--content-max)]');
    expect(className).not.toContain('max-w-[var(--workbench-max)]');
  });

  it('keeps core routes at the page measure and /chat at its own', async () => {
    expect(await frameClass('/dash')).toContain('max-w-[var(--content-max)]');
    expect(await frameClass('/chat')).toContain('max-w-[var(--chat-max)]');
  });

  it('marks the frame so the page shell inside it does not re-cap the workbench', async () => {
    // The inner `.workspace-page` cap keys off this attribute (styles/components/workspace-shell.css).
    // Two percentage caps would otherwise multiply and the workbench would come out narrower than 90%.
    expect(await frame('/p/editor')).toHaveAttribute('data-page-measure', 'workbench');
    expect(await frame('/p/skills')).toHaveAttribute('data-page-measure', 'document');
  });
});
