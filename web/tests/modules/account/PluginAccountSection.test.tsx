import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from '../../test-utils';

const { loadPluginUi } = vi.hoisted(() => ({ loadPluginUi: vi.fn() }));
vi.mock('../../../lib/pluginUi', async (loadOriginal) => ({
  ...(await loadOriginal<typeof import('../../../lib/pluginUi')>()),
  loadPluginUi,
}));

import { PluginAccountSection } from '../../../modules/account/PluginAccountSection';

describe('PluginAccountSection', () => {
  beforeEach(() => loadPluginUi.mockReset());

  it('loads the granted plugin bundle and mounts its declared account panel', async () => {
    loadPluginUi.mockResolvedValue({
      requiresApiVersion: 3,
      account: { connection: () => <div>GitHub OAuth connection</div> },
    });
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper>
        <PluginAccountSection
          entry={{ name: 'github', url: '/plugins/github/web/hash.js', apiVersion: 3, nav: [], account: [{ id: 'connection', label: 'GitHub' }], settings: [] }}
          sectionId="connection"
          onSaveState={() => {}}
        />
      </Wrapper>,
    );

    expect(await screen.findByText('GitHub OAuth connection')).toBeInTheDocument();
    expect(loadPluginUi).toHaveBeenCalledWith('github', '/plugins/github/web/hash.js', undefined);
  });
});
