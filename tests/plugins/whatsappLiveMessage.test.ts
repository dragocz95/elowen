import { describe, it, expect, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

type Msg = { text: string; edit?: unknown };
type Lm = {
  onEvent: (e: Record<string, unknown>) => void;
  finalize: (reply?: string) => Promise<void>;
  progress: { lastEdit: number; flush: () => unknown } | null;
};

/** WhatsApp keeps its OWN Baileys transport while the whole message lifecycle comes from the shared engine
 *  (packages/plugin-shared/liveMessage.mjs). These tests pin the lifecycle rules a WhatsApp-local copy kept
 *  drifting away from — sends serialized (a slow create must not be raced into a second bubble), the last
 *  throttled update landing on its own, the newest rows kept when the trace outgrows the limit, the final
 *  settle retried once — plus the two surface differences that must survive the merge: the stricter
 *  1500 ms edit throttle and the answer arriving as ONE final message instead of a live-edited draft. */
describe('whatsapp LiveMessage (edit lifecycle)', () => {
  const load = async () => (await import(join(repoRoot, 'plugins/whatsapp/lib/stream.mjs'))) as {
    LiveMessage: new (adapter: unknown, jid: string, quoted?: unknown, asker?: string) => Lm;
  };

  /** A fake Baileys adapter: `sock.sendMessage` records the latest progress-bubble text (create + every
   *  edit overwrite the same buffer) and counts creates vs edits. */
  function fakeAdapter(onSend?: (msg: Msg) => Promise<void>) {
    const state = { progress: '', creates: 0, edits: 0, answers: [] as string[] };
    const adapter = {
      // `streaming: true` is the shipped default, and resolveDisplaySettings maps that legacy flag to
      // answerMode 'live' — WhatsApp must still keep its answer out of a live-edited bubble.
      cfg: { runtimeFooter: false, streaming: true },
      sock: {
        sendMessage: async (_jid: string, msg: Msg) => {
          if (msg.edit) state.edits++; else state.creates++;
          await onSend?.(msg);
          state.progress = msg.text;
          return { key: msg.edit ?? { id: 'k1' } };
        },
      },
      resolveImageFiles: () => [],
      sendImages: async () => {},
      sendText: async (_jid: string, body: string) => { state.answers.push(body); },
      postAsk: async () => {},
    };
    return { adapter, state };
  }

  it('never opens a SECOND bubble while the first create is still in flight', async () => {
    const { LiveMessage } = await load();
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    // The first create is slow (a real Baileys send can take seconds) — longer than the edit throttle.
    const { adapter, state } = fakeAdapter(async (msg) => { if (!msg.edit) await gate; });
    const lm = new LiveMessage(adapter, 'jid@s');

    lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
    if (lm.progress) lm.progress.lastEdit = 0; // the throttle window lapsed while the create is unacked
    lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' });

    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(state.creates).toBe(1);           // a raced flush used to post a second progress bubble
    expect(state.progress).toContain('second-tool'); // …and the update still lands, as an edit
  });

  it('lands the last throttled update without waiting for another event', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    vi.useFakeTimers();
    try {
      const lm = new LiveMessage(adapter, 'jid@s');
      lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
      await vi.advanceTimersByTimeAsync(0); // the create settles
      lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' }); // inside the throttle window
      await vi.advanceTimersByTimeAsync(5000);
      // No further event arrives — the trailing flush must still carry the newest trace to the bubble.
      expect(state.progress).toContain('second-tool');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps WhatsApp\'s stricter 1500 ms edit throttle', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    vi.useFakeTimers();
    try {
      const lm = new LiveMessage(adapter, 'jid@s');
      lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
      await vi.advanceTimersByTimeAsync(0); // the create settles
      lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' });
      await vi.advanceTimersByTimeAsync(1300); // past the shared 1200 ms default, still inside WhatsApp's window
      expect(state.progress).not.toContain('second-tool');
      await vi.advanceTimersByTimeAsync(300);
      expect(state.progress).toContain('second-tool');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the final settle once when the first edit fails', async () => {
    const { LiveMessage } = await load();
    let failEdits = 1; // one transient 429/socket blip on the settling edit
    const { adapter, state } = fakeAdapter(async (msg) => {
      if (msg.edit && failEdits > 0) { failEdits--; throw new Error('rate limited'); }
    });
    const lm = new LiveMessage(adapter, 'jid@s');
    lm.onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'first-tool', icon: '💻' });
    await new Promise((r) => setTimeout(r, 0)); // the create lands
    lm.onEvent({ type: 'tool', id: 'b', name: 'Read', detail: 'second-tool', icon: '📄' }); // throttled — still unsent
    await lm.finalize('Done.');
    // A single-attempt settle froze the bubble on the stale draft, with no later drain left to retry it.
    expect(state.progress).toContain('second-tool');
  });

  it('does not edit the answer text live — it lands as ONE final message', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    const lm = new LiveMessage(adapter, 'jid@s');
    for (const delta of ['Hello', ' there']) lm.onEvent({ type: 'text', delta });
    await new Promise((r) => setTimeout(r, 20));
    // A live answer draft would have to be re-anchored/discarded by DELETING it, and a deleted Baileys
    // message leaves a "this message was deleted" tombstone in the chat.
    expect(state.creates).toBe(0);
    await lm.finalize('Hello there');
    expect(state.answers).toEqual(['Hello there']);
  });

  it('keeps the NEWEST rows when the trace outgrows the WhatsApp message limit', async () => {
    const { LiveMessage } = await load();
    const { adapter, state } = fakeAdapter();
    const lm = new LiveMessage(adapter, 'jid@s');
    for (let i = 0; i < 80; i++) {
      lm.onEvent({ type: 'tool', id: `t${i}`, name: `Tool${i}`, detail: `step-${i}-${'x'.repeat(60)}`, icon: '🔧' });
      lm.onEvent({ type: 'tool_output', id: `t${i}`, output: { title: 'out', kind: 'console', text: `result ${i}`, tone: 'success' } });
    }
    await lm.finalize('Done.');
    expect(state.progress.length).toBeLessThanOrEqual(4000);
    expect(state.progress).toContain('step-79-');  // the active tail — dropped by a head-first truncation
    expect(state.progress).not.toContain('step-0-'); // the oldest rows are what gets elided
  });
});

/** A failed turn must settle the live trace BEFORE the error reply goes out. Freezing the bubble without
 *  awaiting the in-flight send let a slow progress create land UNDER the ⚠️ error message. */
describe('whatsapp failed turn (ordering against the error reply)', () => {
  const CHAT = '420123456789@s.whatsapp.net';
  const log = { info() {}, warn() {}, error() {} };

  it('posts the settled progress bubble before the error reply', async () => {
    const { WhatsAppAdapter } = await import(join(repoRoot, 'plugins/whatsapp/lib/adapter.mjs')) as {
      WhatsAppAdapter: new (...args: unknown[]) => {
        meId: string | null;
        sock: unknown;
        listen: (h: (src: unknown, text: string, onEvent: (e: Record<string, unknown>) => void) => Promise<string>) => void;
        onMessage: (m: unknown) => Promise<void>;
      };
    };
    const sends: string[] = [];
    let slowCreatePending = true;
    const adapter = new WhatsAppAdapter(
      { language: 'en', senderPolicies: [{ roleId: CHAT }], streaming: true, reactions: false, runtimeFooter: false },
      log, { get: () => ({}), patch: () => {} }, async () => [], [], '', '', () => false, () => [],
    );
    adapter.meId = '420999888777@s.whatsapp.net';
    adapter.sock = {
      sendPresenceUpdate: async () => {},
      sendMessage: async (_jid: string, msg: { text: string; edit?: unknown }) => {
        // The progress create is slow (a real Baileys send takes a moment); the turn fails meanwhile.
        if (!msg.edit && slowCreatePending) { slowCreatePending = false; await new Promise((r) => setTimeout(r, 10)); }
        sends.push(msg.text);
        return { key: { id: `k${sends.length}` } };
      },
    };
    adapter.listen(async (_src, _text, onEvent) => {
      onEvent({ type: 'tool', id: 'a', name: 'Bash', detail: 'npm test', icon: '💻' });
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('boom');
    });

    await adapter.onMessage({
      key: { remoteJid: CHAT, fromMe: false, id: 'M1' },
      pushName: 'Anna',
      message: { conversation: 'spusť testy' },
    });

    expect(sends[0]).toContain('Bash');            // the tool trace lands first…
    expect(sends[sends.length - 1]).toContain('boom'); // …and the ⚠️ error reply is the LAST message
  });
});
