import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import {
  allServers, filterServers, parseEnvironment, serverDraft, serverKey, serverPayload, McpServersPage,
} from '../../../plugins/mcp/web-src/McpServersPage';
import type { McpServer } from '../../../plugins/mcp/web-src/runtime';
import manifest from '../../../plugins/mcp/elowen-plugin.json';
import { createWrapper } from '../test-utils';

// The page resolves everything through window.ElowenUiRuntime — install the REAL runtime, so this
// exercises the production contract the bundle runs against.
ensurePluginUiRuntime();

const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

/** A row opens through ONE button spanning it, whose accessible name is the manifest's short open
 *  label — not the server name, which is only the text of a cell inside the row. */
const openLabel = (name: string) => strings.openServer!.replace('{name}', name);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const server: McpServer = {
  name: 'github',
  scope: 'personal',
  transport: 'stdio',
  enabled: true,
  status: 'connected',
  toolCount: 1,
  tools: [{ name: 'search', title: 'Search' }],
  lastError: null,
  reconnecting: false,
  command: 'npx',
  args: ['-y', '@example/mcp'],
  env: { TOKEN: 'secret', REGION: 'eu' },
};

const remote: McpServer = {
  name: 'docs',
  scope: 'instance',
  transport: 'http',
  enabled: true,
  status: 'error',
  toolCount: 0,
  tools: [],
  lastError: 'connect ECONNREFUSED',
  reconnecting: false,
  url: 'https://mcp.example.test/',
};

describe('MCP bundle contract', () => {
  it('gates the manifest and built registration on plugin UI API 11', () => {
    const bundle = readFileSync(join(process.cwd(), '..', 'plugins', 'mcp', 'web', 'index.js'), 'utf8');
    expect((manifest as { web: { requiresApiVersion: number } }).web.requiresApiVersion).toBe(11);
    expect(window.ElowenUiRuntime?.apiVersion).toBe(12);
    expect(bundle).toMatch(/requiresApiVersion:\s*11/);
  });
});

describe('MCP settings form mapping', () => {
  it('round-trips a stdio server without losing command arguments or environment values', () => {
    expect(serverPayload(serverDraft(server))).toEqual({
      scope: 'personal',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      env: { TOKEN: 'secret', REGION: 'eu' },
      enabled: true,
    });
  });

  it('keeps everything after the first equals sign in an environment value', () => {
    expect(parseEnvironment('TOKEN=a=b=c\nEMPTY=\nFLAG')).toEqual({ TOKEN: 'a=b=c', EMPTY: '', FLAG: '' });
  });

  it('does not send stale stdio credentials after switching to HTTP', () => {
    const draft = { ...serverDraft(server), transport: 'http' as const, url: 'https://mcp.example.test/' };
    expect(serverPayload(draft)).toEqual({
      scope: 'personal', name: 'github', transport: 'http', url: 'https://mcp.example.test/', enabled: true,
    });
  });
});

describe('MCP register rows', () => {
  it('lists both ownership scopes as one register, personal first', () => {
    expect(allServers({ personal: [server], instance: [remote], canManageInstance: true }).map((row) => row.name))
      .toEqual(['github', 'docs']);
  });

  it('keys a row by scope and name, so the same name in both scopes stays two rows', () => {
    expect(serverKey(server)).not.toBe(serverKey({ ...server, scope: 'instance' }));
  });

  it('narrows by ownership scope and by a needle over name, transport, url and command', () => {
    const rows = [server, remote];
    expect(filterServers(rows, '', 'instance').map((row) => row.name)).toEqual(['docs']);
    expect(filterServers(rows, 'npx', 'all').map((row) => row.name)).toEqual(['github']);
    expect(filterServers(rows, 'example.test', 'all').map((row) => row.name)).toEqual(['docs']);
    expect(filterServers(rows, 'HTTP', 'all').map((row) => row.name)).toEqual(['docs']);
    expect(filterServers(rows, 'nothing', 'all')).toEqual([]);
  });
});

const msw = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'mcp', url: '/plugins/mcp/web/index.js', apiVersion: 2, nav: [], settings: [], strings }])),
);
beforeAll(() => msw.listen({ onUnhandledRequest })); afterEach(() => msw.resetHandlers()); afterAll(() => msw.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><McpServersPage /></Wrapper>);
};

describe('MCP page load states', () => {
  // A failed load leaves the server list undefined, so a loading branch tested BEFORE the error branch
  // swallows the failure: the page would sit on the skeleton forever and never offer Retry.
  it('shows the error state with Retry when the server list fails to load', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
    mount();
    expect(await screen.findByText(strings.loadError!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders the register once the servers arrive', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [remote], canManageInstance: true })));
    mount();
    expect(await screen.findByText('github')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    // The failure lands in the status cell as ONE line, not as a wrapped paragraph in a card.
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument();
    expect(screen.queryByText(strings.loadError!)).not.toBeInTheDocument();
  });

  it('puts the search in the canonical page toolbar and the ownership scope behind its filter control', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [remote], canManageInstance: true })));
    mount();
    const search = await screen.findByRole('searchbox', { name: strings.searchPlaceholder });
    // The row the shell draws under the hero, not a band this bundle lays out inside its own content:
    // a plugin register's controls have to sit where every built-in register's do.
    expect(search.closest('.page-toolbar__search')).not.toBeNull();
    expect(search.closest('.control-surface-toolbar')).toBeNull();

    // The search is permanent and the scope is a filter, so only one of them is on the row itself.
    expect(screen.queryByRole('radiogroup', { name: strings.scope })).toBeNull();
    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    const panel = within(await screen.findByRole('dialog', { name: 'Filters' }));
    expect(panel.getByRole('radiogroup', { name: strings.scope })).toBeInTheDocument();
  });

  it('names the ownership filter in a chip that clears it', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [remote], canManageInstance: true })));
    mount();
    await screen.findByText('github');
    fireEvent.click(screen.getByTestId('page-filters-trigger'));
    fireEvent.click(await screen.findByRole('radio', { name: strings.scopeInstance }));

    // "Instance" alone would not say WHAT it narrows, so the chip carries the field's own label too.
    expect(screen.getByTestId('page-filter-chips')).toHaveTextContent(`${strings.scope}: ${strings.scopeInstance}`);
    expect(screen.queryByText('github')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: `Remove filter ${strings.scope}: ${strings.scopeInstance}` }));
    expect(await screen.findByText('github')).toBeInTheDocument();
  });

  it('offers a non-owner no filter control at all, and keeps the search', async () => {
    // One ownership scope means nothing to narrow, so the toolbar is handed an EMPTY field set — which
    // draws no trigger rather than one that opens an empty panel.
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [], canManageInstance: false })));
    mount();
    await screen.findByText('github');
    expect(screen.queryByTestId('page-filters-trigger')).toBeNull();
    expect(screen.getByRole('searchbox', { name: strings.searchPlaceholder })).toBeInTheDocument();
  });

  it('clears a populated register search through the shared search control', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [remote], canManageInstance: true })));
    mount();
    const search = await screen.findByRole('searchbox', { name: strings.searchPlaceholder });
    fireEvent.change(search, { target: { value: 'github' } });
    expect(screen.queryByText('docs')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: strings.searchClear }));
    expect(search).toHaveValue('');
    expect(screen.getByText('docs')).toBeInTheDocument();
  });
});

// Changing the scope is a MOVE on the daemon, not a field on the PATCH: PATCH resolves the server in the
// scope it is asked for, so sending the new one reads to it as a server that does not exist.
describe('MCP scope transfer', () => {
  it('moves the server before saving the edit, and only when the scope actually changed', async () => {
    const calls: string[] = [];
    let moveBody: unknown;
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [], instance: [remote], canManageInstance: true })),
      http.post('*/api/plugins/mcp/api/transfer', async ({ request }) => {
        calls.push('transfer');
        moveBody = await request.json();
        return HttpResponse.json({ server: { ...remote, scope: 'personal' } });
      }),
      http.patch('*/api/plugins/mcp/api/servers/docs', () => { calls.push('patch'); return HttpResponse.json({ server: remote }); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: openLabel('docs') }));
    const drawer = within(await screen.findByRole('dialog', { name: 'docs' }));

    // The scope picker is a SelectMenu: it renders its options only while the listbox is open.
    fireEvent.click(drawer.getByRole('combobox', { name: strings.scope }));
    fireEvent.click(await screen.findByRole('option', { name: strings.scopePersonal }));
    fireEvent.click(drawer.getByRole('button', { name: strings.save }));

    // The move runs FIRST — a refusal must leave the server in the scope it was in, not edited into one
    // it never reached — and it names where the server is NOW.
    await waitFor(() => expect(calls).toEqual(['transfer', 'patch']));
    expect(moveBody).toEqual({ fromScope: 'instance', name: 'docs', toScope: 'personal' });
  });

  it('saves an ordinary edit without calling the move at all', async () => {
    const calls: string[] = [];
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [], instance: [remote], canManageInstance: true })),
      http.post('*/api/plugins/mcp/api/transfer', () => { calls.push('transfer'); return HttpResponse.json({ server: remote }); }),
      http.patch('*/api/plugins/mcp/api/servers/docs', () => { calls.push('patch'); return HttpResponse.json({ server: remote }); }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: openLabel('docs') }));
    const drawer = within(await screen.findByRole('dialog', { name: 'docs' }));
    fireEvent.change(drawer.getByLabelText(strings.url!), { target: { value: 'https://mcp.example.test/v2' } });
    fireEvent.click(drawer.getByRole('button', { name: strings.save }));

    await waitFor(() => expect(calls).toEqual(['patch']));
  });

  // The daemon refuses a local-process server and a name already taken in the target scope. Those are
  // different problems and the user can only act on the difference, so the page must not flatten both
  // into its own generic message.
  it('shows the daemon refusal rather than a generic save error', async () => {
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [], instance: [remote], canManageInstance: true })),
      http.post('*/api/plugins/mcp/api/transfer', () => HttpResponse.json(
        { error: 'local-process MCP servers cannot change scope — create the server again in the target scope instead' },
        { status: 409 },
      )),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: openLabel('docs') }));
    const drawer = within(await screen.findByRole('dialog', { name: 'docs' }));
    fireEvent.click(drawer.getByRole('combobox', { name: strings.scope }));
    fireEvent.click(await screen.findByRole('option', { name: strings.scopePersonal }));
    fireEvent.click(drawer.getByRole('button', { name: strings.save }));

    expect(await screen.findByText(/local-process MCP servers cannot change scope/)).toBeInTheDocument();
    expect(screen.queryByText(strings.saveError!)).toBeNull();
  });
});

describe('MCP server deletion', () => {
  it('locks pending deletion, blocks a second DELETE and keeps the dialog when the request rejects', async () => {
    let deleteCalls = 0;
    let deleteBody: unknown;
    const response = deferred<Response>();
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [server], instance: [], canManageInstance: false })),
      http.delete('*/api/plugins/mcp/api/servers/github', async ({ request }) => {
        deleteCalls += 1;
        deleteBody = await request.json();
        return await response.promise;
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: openLabel('github') }));
    const drawer = within(await screen.findByRole('dialog', { name: 'github' }));
    fireEvent.click(drawer.getByRole('button', { name: strings.removeServer }));

    const confirmation = within(await screen.findByRole('alertdialog', { name: /github/ }));
    expect(deleteCalls).toBe(0);
    expect(confirmation.getByText(new RegExp(strings.scopePersonal!))).toBeInTheDocument();
    expect(confirmation.getByText(/STDIO/)).toBeInTheDocument();
    const confirm = confirmation.getByRole('button', { name: strings.removeServer });

    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitFor(() => expect(deleteCalls).toBe(1));
    expect(confirmation.getByRole('button', { name: strings.removingServer })).toBeDisabled();
    expect(deleteBody).toEqual({ scope: 'personal' });

    response.resolve(HttpResponse.json({ error: 'delete refused' }, { status: 500 }));

    expect(await confirmation.findByRole('alert')).toHaveTextContent('delete refused');
    expect(screen.getByRole('alertdialog', { name: /github/ })).toBeInTheDocument();
    expect(deleteCalls).toBe(1);
    // Radix makes the register inert behind the alert dialog, but the saved row must still be present.
    expect(document.querySelector(`button[aria-label="${openLabel('github')}"]`)).not.toBeNull();
  });
});

describe('MCP drawer tool list', () => {
  const openDrawer = async (name: string) => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: openLabel(name) }));
    return within(await screen.findByRole('dialog', { name }));
  };

  it('summarizes the bridged tools and opens the full list read-only', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [{ ...server, toolCount: 2, tools: [{ name: 'search', title: 'Search', description: 'Search the repository.' }, { name: 'issues', title: 'Issues' }] }],
      instance: [],
      canManageInstance: false,
    })));
    const drawer = await openDrawer('github');
    expect(drawer.getByText(strings.toolsCount!.replace('{n}', '2'))).toBeInTheDocument();

    fireEvent.click(drawer.getByRole('button', { name: `${strings.viewTools}: github` }));
    const modal = within(await screen.findByRole('dialog', { name: strings.tools }));
    expect(modal.getByText('Search')).toBeInTheDocument();
    expect(modal.getByText('Issues')).toBeInTheDocument();
    // Read-only: the tools are information, so the modal offers no way to change them.
    expect(modal.queryByRole('checkbox')).toBeNull();
    expect(modal.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(modal.getByText('Search').closest('[title]')).toHaveAttribute('title', 'Search the repository.');
  });

  it('offers no modal for a server with nothing bridged', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [{ ...server, toolCount: 0, tools: [] }], instance: [], canManageInstance: false,
    })));
    const drawer = await openDrawer('github');
    expect(drawer.getByText(strings.noTools!)).toBeInTheDocument();
    expect(drawer.queryByRole('button', { name: new RegExp(strings.viewTools!) })).toBeNull();
  });
});
