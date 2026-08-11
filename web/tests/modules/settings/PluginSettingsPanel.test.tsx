import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { PluginSettingsPanel } from '../../../modules/settings/PluginSettingsPanel';
import { loadPluginUi, type PluginUiRegistration } from '../../../lib/pluginUi';
import { en } from '../../../lib/i18n/dictionaries/en';

// The bundle loader injects real <script type=module> tags — deterministically stubbed here; the
// loader itself is covered by the host-route tests and the real bundle path by web-e2e.
vi.mock('../../../lib/pluginUi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/pluginUi')>();
  return { ...actual, loadPluginUi: vi.fn() };
});

const listing = [
  { name: 'demo', url: '/plugins/demo/web/abc.js', apiVersion: 1, nav: [], settings: [{ id: 'general', label: 'Demo' }] },
  { name: 'future', url: '/plugins/future/web/def.js', apiVersion: 99, nav: [], settings: [{ id: 'x', label: 'Future' }] },
];
const server = setupServer(http.get('*/api/plugins/ui', () => HttpResponse.json(listing)));
beforeAll(() => server.listen({ onUnhandledRequest }));
beforeEach(() => vi.mocked(loadPluginUi).mockReset());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mount = (plugin: string, settingId = 'general') => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><PluginSettingsPanel plugin={plugin} settingId={settingId} /></Wrapper>);
};

describe('PluginSettingsPanel', () => {
  it('renders the settings component the bundle registered, with the settings page props', async () => {
    const seen: unknown[] = [];
    vi.mocked(loadPluginUi).mockResolvedValue({
      requiresApiVersion: 1,
      settings: { general: (props) => { seen.push(props); return <div data-testid="demo-settings">plugin panel</div>; } },
    } satisfies PluginUiRegistration);
    mount('demo');
    expect(await screen.findByTestId('demo-settings')).toBeInTheDocument();
    expect(seen[0]).toMatchObject({ plugin: 'demo', params: { id: 'general' }, rest: ['settings', 'general'] });
    expect(vi.mocked(loadPluginUi)).toHaveBeenCalledWith('demo', '/plugins/demo/web/abc.js');
  });

  it('declared-but-unregistered section gets the honest placeholder', async () => {
    vi.mocked(loadPluginUi).mockResolvedValue({ requiresApiVersion: 1 });
    mount('demo');
    expect(await screen.findByText(en.pluginUi.settingsUnavailable)).toBeInTheDocument();
  });

  it('covers the failure ladder: not listed, incompatible, bundle load failed', async () => {
    vi.mocked(loadPluginUi).mockResolvedValue(null);
    mount('gone');
    expect(await screen.findByText(en.pluginUi.unavailable)).toBeInTheDocument();
    mount('future', 'x');
    expect(await screen.findByText(en.pluginUi.incompatible)).toBeInTheDocument();
    mount('demo');
    expect(await screen.findByText(en.pluginUi.loadFailed)).toBeInTheDocument();
  });

  it('a crashing plugin component stays inside the error boundary', async () => {
    const Bomb = () => { throw new Error('boom'); };
    vi.mocked(loadPluginUi).mockResolvedValue({ requiresApiVersion: 1, settings: { general: Bomb } });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mount('demo');
      expect(await screen.findByText(en.pluginUi.crashed)).toBeInTheDocument();
    } finally { quiet.mockRestore(); }
  });
});
