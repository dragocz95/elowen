import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';

describe('ChatState', () => {
  it('owns one mutable UI state object and keeps TranscriptModel as its only transcript authority', () => {
    const transcript = new TranscriptModel([{ role: 'user', text: 'hello' }]);
    const state = new ChatState({ transcript, modelName: 'gpt-test', showThoughts: true });
    expect(state.transcript).toBe(transcript);
    expect(state.modelName).toBe('gpt-test');
    expect(state.queued).toEqual([]);
    expect(state.pendingImages).toEqual([]);

    transcript.apply({ type: 'text', delta: 'reply' });
    expect(state.transcript).toBe(transcript);
    expect(state.transcript.turnAt(state.transcript.turnCount - 1)?.role).toBe('elowen');
  });
});
