import { describe, expect, it, vi } from 'vitest';
import { Container } from '@earendil-works/pi-tui';
import type { Component, Editor, TUI } from '@earendil-works/pi-tui';
import { AskChoiceDock } from '../../../src/cli/chat/askFlow.js';
import { ChatApplicationLifetime } from '../../../src/cli/chat/applicationLifetime.js';
import { createFlows } from '../../../src/cli/chat/flows.js';
import type { AskQuestion } from '../../../src/brain/events.js';
import type { ChatState } from '../../../src/cli/chat/chatState.js';
import type { ChatApplicationActions, ChatApplicationResources } from '../../../src/cli/chat/chatCapabilities.js';

const question = (text: string, header: string): AskQuestion => ({
  question: text,
  header,
  multiSelect: false,
  options: [{ label: 'A' }, { label: 'B' }],
});

const fakeTui = (): TUI => ({
  requestRender: vi.fn(),
  setFocus: vi.fn(),
}) as unknown as TUI;

function setup(client: { answer: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> }) {
  const tui = fakeTui();
  const editorSlot = new Container();
  const editor = { render: () => ['editor'] } as Component as Editor;
  editorSlot.addChild(editor);
  const lifetime = new ChatApplicationLifetime<string>();
  const flows = createFlows(
    { brand: { agentName: 'Elowen' } } as ChatState,
    { client, tui, editor, editorSlot, lifetime } as unknown as Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'editorSlot' | 'lifetime'>,
    { render: vi.fn() } as unknown as Pick<ChatApplicationActions, 'render'>,
  );
  return { flows, editorSlot, lifetime };
}

describe('CLI AskUserQuestion answer reconciliation', () => {
  it('rehydrates the authoritative pending prompt when the server returns matched:false', async () => {
    const current = question('Current choice?', 'Current');
    const client = {
      answer: vi.fn(async () => false),
      status: vi.fn(async () => ({ pendingAsk: { id: 'ask-current', questions: [current] } })),
    };
    const { flows, editorSlot, lifetime } = setup(client);

    flows.launchAsk('ask-stale', [question('Stale choice?', 'Stale')]);
    expect(editorSlot.children[0]).toBeInstanceOf(AskChoiceDock);
    editorSlot.children[0]!.handleInput?.('\r');

    await vi.waitFor(() => expect(client.status).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(editorSlot.children[0]).toBeInstanceOf(AskChoiceDock));
    expect(editorSlot.children[0]!.render?.(80).join('\n')).toContain('Current choice?');
    await lifetime.stop();
  });

  it('does not let a stale matched:false response replace a newer concurrent prompt', async () => {
    let settleAnswer!: (matched: boolean) => void;
    const answer = new Promise<boolean>((resolve) => { settleAnswer = resolve; });
    const client = {
      answer: vi.fn(() => answer),
      status: vi.fn(async () => ({ pendingAsk: null })),
    };
    const { flows, editorSlot, lifetime } = setup(client);

    flows.launchAsk('ask-old', [question('Old choice?', 'Old')]);
    editorSlot.children[0]!.handleInput?.('\r');
    flows.launchAsk('ask-new', [question('New choice?', 'New')]);
    settleAnswer(false);

    await vi.waitFor(() => expect(client.answer).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(client.status).not.toHaveBeenCalled();
    expect(editorSlot.children[0]!.render?.(80).join('\n')).toContain('New choice?');
    await lifetime.stop();
  });
});
