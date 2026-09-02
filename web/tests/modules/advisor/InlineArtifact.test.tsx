import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { PluginChatArtifactProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { createWrapper } from '../../test-utils';
import type { BrainInlineArtifact, PluginUiListing } from '../../../lib/types';
import { InlineArtifact } from '../../../modules/advisor/InlineArtifact';

const mocks = vi.hoisted(() => ({
  loadPluginUi: vi.fn(),
  listing: { data: [] as PluginUiListing[], isLoading: false },
}));

vi.mock('../../../lib/queries', () => ({ usePluginUi: () => mocks.listing }));
vi.mock('../../../lib/pluginUi', () => ({
  PLUGIN_UI_API_VERSION: 13,
  loadPluginUi: mocks.loadPluginUi,
}));

const artifact: BrainInlineArtifact = {
  id: 'artifact-1',
  plugin: 'browser',
  sessionId: 'brain-1',
  toolCallId: 'tool-1',
  view: 'preview',
  fallback: 'Browser preview is unavailable.',
  data: { title: 'Elowen' },
  expiresAt: '2030-01-01T00:00:00.000Z',
  status: 'open',
  createdAt: '2029-01-01T00:00:00.000Z',
  updatedAt: '2029-01-01T00:00:00.000Z',
};

const entry: PluginUiListing = {
  name: 'browser',
  url: '/plugins/browser/web/hash.js',
  cssUrl: '/plugins/browser/web/hash.css',
  apiVersion: 13,
  nav: [],
  settings: [],
};

function draw(value: BrainInlineArtifact = artifact) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><InlineArtifact artifact={value} /></Wrapper>);
}

beforeEach(() => {
  mocks.loadPluginUi.mockReset();
  mocks.listing.data = [entry];
  mocks.listing.isLoading = false;
});

describe('InlineArtifact', () => {
  it('loads the matching plugin bundle lazily and passes the normalized artifact props', async () => {
    let resolve!: (registration: PluginUiRegistration) => void;
    mocks.loadPluginUi.mockReturnValue(new Promise<PluginUiRegistration>((done) => { resolve = done; }));
    const View = ({ plugin, artifact: value }: PluginChatArtifactProps) => (
      <div data-testid="artifact-view">{plugin}:{value.id}:{String((value.data as { title: string }).title)}</div>
    );

    draw();
    expect(screen.queryByTestId('artifact-view')).not.toBeInTheDocument();
    expect(screen.queryByText(artifact.fallback)).not.toBeInTheDocument();
    expect(mocks.loadPluginUi).toHaveBeenCalledWith(entry.name, entry.url, entry.cssUrl);

    await act(async () => resolve({ requiresApiVersion: 13, chatArtifacts: { preview: View } }));
    expect(await screen.findByTestId('artifact-view')).toHaveTextContent('browser:artifact-1:Elowen');
  });

  it('renders the artifact fallback when the bundle is unavailable', async () => {
    mocks.loadPluginUi.mockResolvedValue(null);
    draw();
    expect(await screen.findByText(artifact.fallback)).toBeInTheDocument();
  });

  it('renders the artifact fallback when the bundle did not register the requested view', async () => {
    mocks.loadPluginUi.mockResolvedValue({ requiresApiVersion: 13, chatArtifacts: {} });
    draw();
    expect(await screen.findByText(artifact.fallback)).toBeInTheDocument();
  });

  it('contains a crashing plugin component inside the artifact fallback', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const CrashingView = () => { throw new Error('broken artifact view'); };
    mocks.loadPluginUi.mockResolvedValue({
      requiresApiVersion: 13,
      chatArtifacts: { preview: CrashingView },
    });

    draw();
    expect(await screen.findByText(artifact.fallback)).toBeInTheDocument();
    expect(screen.queryByTestId('artifact-view')).not.toBeInTheDocument();
    error.mockRestore();
  });
});
