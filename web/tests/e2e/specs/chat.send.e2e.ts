// P0-3 — the send round-trip over the real EventSource → BFF → transcript-reducer pipeline. The user
// turn is authored by the daemon's `user` echo (no optimistic local bubble), the assistant answer
// ACCUMULATES across text deltas (not replaced), and the busy/Stop affordance shows while streaming and
// clears on idle — all with no duplicated turns.
import { test, expect, ChatPage } from '../fixtures/index.ts';

test('@smoke P0-3 sending a message streams an accumulating reply and clears busy on idle', async ({ app, seed, sse }) => {
  await seed.messages([]); // start from an empty conversation so turn counts are unambiguous

  const chat = new ChatPage(app);
  await chat.goto();

  // Not streaming yet: Send is present, Stop is not.
  await expect(chat.sendButton).toBeVisible();
  await expect(chat.stopButton).toHaveCount(0);

  await chat.sendMessage('What is the capital of France?');

  // The daemon echoes the user's turn (this is what renders the 'you' bubble) and flips busy on.
  await sse.user('What is the capital of France?');
  await expect(chat.turnsByRole('you')).toHaveCount(1);
  await expect(chat.turnsByRole('you')).toContainText('What is the capital of France?');
  // Busy: the Stop button replaces Send while the turn streams.
  await expect(chat.stopButton).toBeVisible();
  await expect(chat.sendButton).toHaveCount(0);

  // Stream the answer word-by-word — the reducer must APPEND deltas, never replace the segment.
  await sse.deltas('The capital is Paris');
  const assistant = chat.turnsByRole('assistant');
  await expect(assistant).toHaveCount(1);
  await expect(assistant).toContainText('The capital is Paris');

  // Idle ends the turn: Stop clears, Send returns.
  await sse.idle();
  await expect(chat.stopButton).toHaveCount(0);
  await expect(chat.sendButton).toBeVisible();

  // No duplicate turns: exactly one 'you' and one 'assistant'.
  await expect(chat.turnsByRole('you')).toHaveCount(1);
  await expect(chat.turnsByRole('assistant')).toHaveCount(1);
  await expect(chat.turns()).toHaveCount(2);
});
