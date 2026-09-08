import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ensurePluginUiRuntime } from '../../lib/pluginUi';
import {
  allServers, canManageServer, canReconnect, filterServers, parseEnvironment, reconnectTargets,
  serverDraft, serverKey, serverPayload, McpServersPage,
} from '../../../plugins/mcp/web-src/McpServersPage';
import type { McpServer } from '../../../plugins/mcp/web-src/runtime';
import manifest from '../../../plugins/mcp/elowen-plugin.json';
import { ToastProvider } from '../../components/ui/Toast';
import { createWrapper } from '../test-utils';

// The page resolves everything through window.ElowenUiRuntime — install the REAL runtime, so this
// exercises the production contract the bundle runs against.
ensurePluginUiRuntime();

const strings = (manifest as { web: { strings: Record<string, string> } }).web.strings;

const stdioServer: McpServer = {
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

const remoteServer: McpServer = {
  name: 'docs',
  scope: 'personal',
  transport: 'http',
  enabled: true,
  status: 'connected',
  toolCount: 2,
  tools: [],
  lastError: null,
  reconnecting: false,
  url: 'https://mcp.example.test/',
  revision: 3,
};

const msw = setupServer(
  http.get('*/api/plugins/ui', () => HttpResponse.json([{ name: 'mcp', url: '/plugins/mcp/web/index.js', apiVersion: 11, nav: [], settings: [], strings }])),
);
beforeAll(() => msw.listen({ onUnhandledRequest }));
afterEach(() => { cleanup(); msw.resetHandlers(); });
afterAll(() => msw.close());

const mount = () => {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><McpServersPage /></ToastProvider></Wrapper>);
};

describe('mcp register rows', () => {
  it('lists both ownership scopes as one register, personal first', () => {
    expect(allServers({ personal: [stdioServer], instance: [{ ...remoteServer, scope: 'instance' }], canManageInstance: true }).map((row) => row.name))
      .toEqual(['github', 'docs']);
  });

  it('keys a row by scope and name, so the same name in both scopes stays two rows', () => {
    expect(serverKey(stdioServer)).not.toBe(serverKey({ ...stdioServer, scope: 'instance' }));
  });

  it('narrows by ownership scope and by a needle over name, transport, url and command', () => {
    const rows = [stdioServer, { ...remoteServer, scope: 'instance' as const }];
    expect(filterServers(rows, '', 'instance').map((row) => row.name)).toEqual(['docs']);
    expect(filterServers(rows, 'npx', 'all').map((row) => row.name)).toEqual(['github']);
    expect(filterServers(rows, 'example.test', 'all').map((row) => row.name)).toEqual(['docs']);
    expect(filterServers(rows, 'nothing', 'all')).toEqual([]);
  });

  // Write authority is its own question: turning a server back ON is a write, so it cannot be gated on
  // the server already being enabled the way reconnect is.
  it('separates write authority from the reconnect gate', () => {
    // A local-process server is an administrator's alone, whatever its state.
    expect(canManageServer(stdioServer, false)).toBe(false);
    expect(canManageServer(stdioServer, true)).toBe(true);
    // A disabled remote server is still writable — that is the only way to turn it back on.
    expect(canManageServer({ ...remoteServer, enabled: false }, false)).toBe(true);
    expect(canReconnect({ ...remoteServer, enabled: false }, false)).toBe(false);
  });

  it('targets only manageable disconnected or failed servers for reconnect-all', () => {
    const failed = { ...remoteServer, name: 'failed', status: 'error', lastError: 'connect ECONNREFUSED' };
    const disabled = { ...remoteServer, name: 'disabled', enabled: false };
    expect(reconnectTargets([remoteServer, failed, stdioServer, disabled], false).map((entry) => entry.name))
      .toEqual(['failed']);
  });
});

describe('mcp settings form mapping', () => {
  it('does not round-trip write-only environment values from an existing server', () => {
    expect(serverPayload(serverDraft(stdioServer))).toEqual({
      scope: 'personal',
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp'],
      enabled: true,
    });
  });

  it('keeps everything after the first equals sign in an environment value', () => {
    expect(parseEnvironment('TOKEN=a=b=c\nEMPTY=\nFLAG')).toEqual({ TOKEN: 'a=b=c', EMPTY: '', FLAG: '' });
  });
});

describe('mcp page load states', () => {
  // A failed load leaves the server list undefined, so a loading branch tested BEFORE the error branch
  // swallows the failure: the page would sit on the skeleton forever and never offer Retry.
  it('shows the error state with Retry when the server list fails to load', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ error: 'nope' }, { status: 500 })));
    mount();
    expect(await screen.findByText(strings.loadError!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('renders the register once the servers arrive', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [stdioServer], instance: [{ ...remoteServer, scope: 'instance', status: 'error', lastError: 'connect ECONNREFUSED' }], canManageInstance: true,
    })));
    mount();
    expect(await screen.findByText('github')).toBeInTheDocument();
    // The failure lands in the status cell as ONE line, not as a wrapped paragraph in a card.
    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument();
    expect(screen.queryByText(strings.loadError!)).not.toBeInTheDocument();
  });
});

describe('mcp register row switch', () => {
  /** The switch on the collapsed row. The drawer's carries the same name, so this stays in the register. */
  const rowSwitch = (name: string) =>
    within(screen.getByRole('table')).getByRole('switch', { name: `${name}: ${strings.enabled}` });

  it('disables a server from its row and re-reads the register the write changed', async () => {
    let enabled = true;
    let body: Record<string, unknown> | undefined;
    let loads = 0;
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => {
        loads += 1;
        return HttpResponse.json({
          personal: [{ ...remoteServer, enabled, status: enabled ? 'connected' : 'disabled', toolCount: enabled ? 2 : 0 }],
          instance: [], canManageInstance: false,
        });
      }),
      http.patch('*/api/plugins/mcp/api/servers/docs', async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        enabled = false;
        return HttpResponse.json({ server: { ...remoteServer, enabled: false } });
      }),
    );
    mount();
    await screen.findByText('docs');

    fireEvent.click(rowSwitch('docs'));
    // Optimistic: the switch answers the click, not the round-trip.
    expect(rowSwitch('docs')).toHaveAttribute('aria-checked', 'false');
    await waitFor(() => expect(body).toMatchObject({ scope: 'personal', enabled: false, expectedRevision: 3 }));
    // Disabling disconnects the server, so its live status and tool count are re-read rather than guessed.
    await waitFor(() => expect(loads).toBe(2));
    await waitFor(() => expect(screen.getAllByText(strings.statusDisabled!).length).toBeGreaterThan(0));
  });

  // Every register in the app carries its row switch at the left edge. The live status dot follows it and
  // still sits beside the name; the two state different things and neither may take the other's place.
  it('leads the row with the switch, ahead of every other cell and control', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [remoteServer], instance: [], canManageInstance: false,
    })));
    mount();
    await screen.findByText('docs');

    const row = within(screen.getByRole('table')).getByText('docs').closest('[role="row"]') as HTMLElement;
    const cells = within(row).getAllByRole('cell');
    expect(within(cells[0]).getByRole('switch')).toBe(rowSwitch('docs'));
    // The row-open overlay is a button of its own, so "first" is measured over every control in the row.
    expect(row.querySelectorAll('button')[0]).toBe(rowSwitch('docs'));
    // The switch track leads both the header row and the grid template it is measured against.
    const table = screen.getByRole('table');
    expect(table.style.getPropertyValue('--data-table-columns').trim().startsWith('2.75rem')).toBe(true);
  });

  it('puts the switch back, with the daemon\'s reason, when the write is refused', async () => {
    msw.use(
      http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({ personal: [remoteServer], instance: [], canManageInstance: false })),
      http.patch('*/api/plugins/mcp/api/servers/docs', () => HttpResponse.json({ error: 'server changed on the server' }, { status: 409 })),
    );
    mount();
    await screen.findByText('docs');

    fireEvent.click(rowSwitch('docs'));
    await waitFor(() => expect(rowSwitch('docs')).toHaveAttribute('aria-checked', 'true'));
    expect(await screen.findByText('server changed on the server')).toBeInTheDocument();
  });

  // A local-process server can start a process on the host, so the daemon lets only an administrator of
  // this instance write one — even a personal one. A switch whose write always comes back refused is
  // worse than showing the state as read-only.
  it('offers no row switch on a local-process server to a non-administrator', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [stdioServer, remoteServer], instance: [], canManageInstance: false,
    })));
    mount();
    await screen.findByText('github');

    expect(rowSwitch('github')).toBeDisabled();
    expect(rowSwitch('docs')).toBeEnabled();
  });
});

// The register's footer is the app's one pager, page-size select included, so /p/mcp reads exactly like
// the skills register rather than growing a footer of its own.
describe('mcp register footer', () => {
  it('offers the rows-per-page select beside the range', async () => {
    msw.use(http.get('*/api/plugins/mcp/api/servers', () => HttpResponse.json({
      personal: [remoteServer], instance: [], canManageInstance: false,
    })));
    mount();
    await screen.findByText('docs');

    const pager = screen.getByRole('navigation', { name: strings.title! });
    expect(within(pager).getByRole('combobox', { name: 'Per page' })).toBeInTheDocument();
  });
});
