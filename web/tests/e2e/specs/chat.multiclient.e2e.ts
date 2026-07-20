// P0-7 — two chat clients on ONE conversation: session-scoped abort + generation fencing.
//
// Two independently-authed pages in their OWN browser contexts (app / app2) each get a distinct per-tab
// brain clientId, so they open TWO separate `/brain/stream` connections on the same session `brain-1`. The
// daemon echoes a user turn to every watcher (`user` event is session-addressed), so BOTH go busy; the Stop
// button is shown iff `busy`. Abort is SESSION-scoped, not client-fenced: `abort()` (BrainChatProvider.tsx:474)
// posts only `{session}`, the daemon cancels the run, and the terminal `idle` fans out to EVERY tap — so Stop
// clicked in page A settles busy in BOTH A and B.
//
// Generation fencing — where it actually lives. The web opens its EventSource with a `generation` and trusts
// the daemon to deliver only that generation's frames; it guards superseded *async HTTP results* by generation
// (connect/loadHistory/status) but does NOT inspect a generation field on incoming SSE frames — the frame-level
// stale-run fence is the DAEMON's job (a superseded run's late output is never sent to a client attached at a
// newer generation). The fake models exactly that: `/brain/stream` records the generation it was opened at, and
// an emit carrying a `generation` is delivered ONLY to matching streams. So a STALE-generation frame is dropped
// server-side (delivered:0) and never reaches either live client — which is the real end-to-end contract, with
// no phantom web-side frame filtering asserted.
import { test, expect, ChatPage } from '../fixtures/index.ts';
import { DEFAULT_SESSION_ID } from '../seed/fixtures.ts';

test('@smoke P0-7 Stop in one client settles both, and a stale-generation frame is dropped', async ({ app, app2, seed, sse, calls }) => {
  await seed.messages([]); // empty conversation → unambiguous turn counts across both clients

  const chatA = new ChatPage(app);
  const chatB = new ChatPage(app2);

  // Prior specs' EventSources can still be draining on `brain-1` (their contexts closed but the server-side
  // stream unregisters async), so we diff against that baseline instead of asserting an absolute count.
  const pre = new Set(await chatA.streamClients());
  await chatA.goto();
  await chatB.goto();

  // Two contexts ⇒ two DISTINCT new clients ⇒ two fresh streams on the one conversation.
  await expect
    .poll(async () => new Set((await chatA.streamClients()).filter((c) => !pre.has(c))).size)
    .toBeGreaterThanOrEqual(2);

  // The daemon's authoritative `user` echo is session-addressed → both watchers render the turn and go busy.
  await sse.user('are we live?');
  await expect(chatA.turnsByRole('you')).toContainText('are we live?');
  await expect(chatB.turnsByRole('you')).toContainText('are we live?');
  await expect(chatA.stopButton).toBeVisible();
  await expect(chatB.stopButton).toBeVisible();
  await expect(chatA.sendButton).toHaveCount(0);
  await expect(chatB.sendButton).toHaveCount(0);

  // Stop in A only. It posts `/brain/abort` for the bound session (no client/generation) — the fake cancels
  // and fans a terminal `idle` to EVERY stream of the session.
  await chatA.stop();
  await expect.poll(async () => (await calls.aborts()).length).toBe(1);
  expect((await calls.aborts())[0]).toMatchObject({ session: DEFAULT_SESSION_ID });

  // BOTH clients settle: Stop clears, Send returns, neither is busy — session-scoped, not client-scoped.
  await expect(chatA.stopButton).toHaveCount(0);
  await expect(chatB.stopButton).toHaveCount(0);
  await expect(chatA.sendButton).toBeVisible();
  await expect(chatB.sendButton).toBeVisible();

  // --- Generation fencing: a stale-generation frame is dropped by the daemon, never reaching either client. ---
  // Every first-connect opens at generation "1"; a session switch would bump it, but nothing here switches.
  const live = (await chatA.streamGenerations()).find((g) => g) ?? '1';

  // A frame minted for a SUPERSEDED generation: same session addressing, only the generation differs. No
  // open stream sits at that generation, so the daemon delivers it to nobody.
  const staleDelivered = await sse.emit(
    { type: 'text', delta: 'STALE-GEN-FRAME' },
    { session: DEFAULT_SESSION_ID, generation: 'superseded-generation' },
  );
  expect(staleDelivered).toBe(0);

  // A frame at the LIVE generation, same addressing, reaches the open streams and renders in BOTH clients —
  // proving the drop above was the generation fence, not a broken address. It also acts as a flush: once it
  // has landed in both, any (wrongly) delivered stale frame would have rendered too.
  const liveDelivered = await sse.emit(
    { type: 'text', delta: 'LIVE-GEN-FRAME' },
    { session: DEFAULT_SESSION_ID, generation: live },
  );
  expect(liveDelivered).toBeGreaterThanOrEqual(2);
  await expect(chatA.transcript).toContainText('LIVE-GEN-FRAME');
  await expect(chatB.transcript).toContainText('LIVE-GEN-FRAME');

  // The stale frame was discarded end to end: it is present in neither transcript.
  await expect(chatA.transcript).not.toContainText('STALE-GEN-FRAME');
  await expect(chatB.transcript).not.toContainText('STALE-GEN-FRAME');
});
