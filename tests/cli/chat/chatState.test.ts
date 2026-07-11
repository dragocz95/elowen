import { describe, expect, it } from 'vitest';
import { TranscriptModel } from '../../../src/brain/transcriptModel.js';
import { ChatState } from '../../../src/cli/chat/chatState.js';

describe('ChatState', () => {
  it('owns one mutable UI state object and projects its transcript view without a second copy', () => {
    const transcript = new TranscriptModel([{ role: 'user', text: 'hello' }]);
    const state = new ChatState({ transcript, modelName: 'gpt-test', showThoughts: true });
    expect(state.transcript).toBe(transcript);
    expect(state.view).toBe(transcript.view);
    expect(state.modelName).toBe('gpt-test');
    expect(state.queued).toEqual([]);
    expect(state.pendingImages).toEqual([]);

    transcript.apply({ type: 'text', delta: 'reply' });
    expect(state.view).toBe(transcript.view);
    expect(state.view.turns.at(-1)?.role).toBe('elowen');
  });
});
