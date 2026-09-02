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
  // The host is on 14; the fixtures below stay on 13 so the older-bundle path (`requiresApiVersion <=
  // host`) keeps being exercised by the same suite.
  PLUGIN_UI_API_VERSION: 14,
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

function draw(value: BrainInlineArtifact = artifact, narration?: string) {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><InlineArtifact artifact={value} narration={narration} /></Wrapper>);
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

  it('hands the artifact the current assistant narration, and nothing else about the chat', async () => {
    const seen: PluginChatArtifactProps[] = [];
    const View = (props: PluginChatArtifactProps) => {
      seen.push(props);
      return <div data-testid="artifact-view">{props.narration}</div>;
    };
    mocks.loadPluginUi.mockResolvedValue({ requiresApiVersion: 14, chatArtifacts: { preview: View } });

    const { wrapper: Wrapper } = createWrapper();
    const show = (narration?: string) => <Wrapper><InlineArtifact artifact={artifact} narration={narration} /></Wrapper>;
    const view = render(show('Opening the portal'));
    expect(await screen.findByTestId('artifact-view')).toHaveTextContent('Opening the portal');
    // The whole chat contract is three props: the plugin name, its own artifact, and the visible prose.
    // No transcript, no turns, no tool payloads — a bundle cannot reach past its own slot.
    expect(Object.keys(seen[0]!).sort()).toEqual(['artifact', 'narration', 'plugin']);

    // Streaming updates it in place…
    view.rerender(show('Opening the portal and signing in.'));
    expect(screen.getByTestId('artifact-view')).toHaveTextContent('Opening the portal and signing in.');

    // …and it clears rather than leaving the previous turn's text on a covering surface. A host older
    // than API 14 passes nothing at all, which must reach the bundle as the same empty value.
    view.rerender(show(''));
    expect(screen.getByTestId('artifact-view')).toBeEmptyDOMElement();
    view.rerender(show(undefined));
    expect(seen.at(-1)!.narration).toBe('');
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
