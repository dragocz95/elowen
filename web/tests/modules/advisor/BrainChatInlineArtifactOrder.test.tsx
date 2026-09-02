import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BrainInlineArtifact } from '../../../lib/types';
import type { ChatTurn } from '../../../lib/transcript';
import { createWrapper } from '../../test-utils';
import { Message } from '../../../modules/advisor/BrainChatSurface';

vi.mock('../../../modules/advisor/InlineArtifact', () => ({
  InlineArtifact: ({ artifact }: { artifact: BrainInlineArtifact }) => (
    <div data-testid="artifact-slot">{artifact.fallback}</div>
  ),
}));

const artifact: BrainInlineArtifact = {
  id: 'artifact-1',
  plugin: 'browser',
  sessionId: 'brain-1',
  toolCallId: 'tool-target',
  view: 'preview',
  fallback: 'Inline browser preview',
  expiresAt: '2030-01-01T00:00:00.000Z',
  status: 'open',
  createdAt: '2029-01-01T00:00:00.000Z',
  updatedAt: '2029-01-01T00:00:00.000Z',
};

const turn: ChatTurn = {
  role: 'elowen',
  streaming: false,
  segments: [
    { kind: 'tools', items: [{ name: 'OtherTool', id: 'tool-other' }] },
    { kind: 'text', text: 'between tool segments' },
    { kind: 'tools', items: [{ name: 'BrowserOpen', id: 'tool-target' }] },
    { kind: 'text', text: 'after artifact' },
  ],
};

describe('inline artifact transcript placement', () => {
  it('renders an artifact immediately after the tool segment containing its toolCallId', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(
      <Wrapper>
        <Message turn={turn} artifacts={[artifact]} showThoughts />
      </Wrapper>,
    );

    const target = screen.getByText('BrowserOpen').closest('[data-testid="chat-tool-pill"]')!;
    const slot = screen.getByTestId('artifact-slot');
    const after = screen.getByText('after artifact');
    expect(screen.getAllByTestId('artifact-slot')).toHaveLength(1);
    expect(target.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
