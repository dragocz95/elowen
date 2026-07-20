// P0-6 — switching the model IN PLACE. Picking a model from the header picker posts `/brain/model` and,
// crucially, does NOT tear the conversation down: the daemon respawns the session under the new model on
// the SAME id, so the EventSource stays open (no reconnect ⇒ no new stream, same generation) and the
// transcript is kept. The initiator updates its picker label from the HTTP response immediately; the
// persisted "model → X" marker renders once the `session-event` reload lands. This mirrors the real route
// (`d.brain.switchModel`): in-place respawn, no SSE reconnect, all attached clients reconcile via the pushed
// marker + status refetch.
//
// How the fake mirrors the real daemon (fake-daemon/handlers/brain.ts): `POST /brain/model` records the call,
// remembers the new model (so `GET /brain/status` reports it), persists a `model → X` event marker into the
// served history, and pushes a `session-event` to the session's open streams. The web's `session-event`
// listener (BrainChatProvider.tsx:357) then refetches history (rendering the marker) + status WITHOUT
// reconnecting — exactly the behavior under test.
//
// Robustness note: prior specs' EventSources can linger briefly on `brain-1` (their contexts closed but the
// server-side stream drains async), so this spec never asserts an absolute stream COUNT. It asserts the live
// page's stream did not reconnect by capturing the highest open id before the switch and proving no NEWER id
// appeared after it (a reconnect always registers a higher id) — and that a scripted frame still lands.
import { test, expect, ChatPage } from '../fixtures/index.ts';

test('@smoke P0-6 switching the model keeps the stream + transcript and renders a marker', async ({ app, seed, sse, calls }) => {
  // A small, known transcript so "not wiped" is unambiguous.
  await seed.messages([
    { id: 'u1', role: 'user', text: 'Ping' },
    { id: 'a1', role: 'assistant', text: 'Pong', segments: [{ kind: 'text', text: 'Pong' }] },
  ]);

  const chat = new ChatPage(app);
  await chat.goto();

  // Mount label = the status model. This page's stream is the NEWEST open one (highest id); a reconnect
  // during the switch would register a still-higher id.
  await expect(chat.modelTrigger()).toContainText('claude-sonnet-4');
  const beforeMax = Math.max(...(await chat.streamIds()));

  // Switch to the other catalog model (the picker's option text is the model id).
  await chat.selectModel('claude-opus-4');

  // The web posted exactly one `/brain/model` for the bound conversation, carrying the chosen provider+model.
  await expect.poll(async () => (await calls.models()).length).toBe(1);
  const [switchCall] = await calls.models();
  expect(switchCall).toMatchObject({ provider: 'oauth-anthropic', model: 'claude-opus-4', session: 'brain-1' });

  // Initiator label moves off the HTTP response alone (no reload needed).
  await expect(chat.modelTrigger()).toContainText('claude-opus-4');

  // The pushed `session-event` reload renders the persisted marker ("model → claude-opus-4"), interleaved as
  // an event turn — proof the switch was reconciled through the reduce/history path, not just the label.
  await expect(chat.eventMarker()).toBeVisible();
  await expect(chat.eventMarker()).toContainText('claude-opus-4');
  await expect(chat.turnsByRole('event')).toHaveCount(1);

  // Transcript NOT wiped: the pre-switch turns are still there after the in-place respawn + reload.
  await expect(chat.turnsByRole('you')).toContainText('Ping');
  await expect(chat.turnsByRole('assistant')).toContainText('Pong');

  // The EventSource survived: the live stream is still open and NO newer stream was registered — i.e. no
  // reconnect happened, so the generation is unchanged (a reconnect closes+reopens the ES under a new id).
  const afterIds = await chat.streamIds();
  expect(afterIds).toContain(beforeMax);
  expect(afterIds.filter((id) => id > beforeMax)).toEqual([]);

  // …and it is still LIVE: a scripted frame pushed after the switch lands on that same open stream.
  await sse.text('post-switch delta');
  await expect(chat.transcript).toContainText('post-switch delta');
});
