import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
});

describe('MCP drawer tool list', () => {
  const openDrawer = async (name: string) => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name }));
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
