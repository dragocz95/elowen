// The transport-neutral live-message engine for the chat adapters: the throttled editable message, the
// streaming answer split into ordered continuation bubbles, and the brain-event → live-bubble reducer.
// This is the layer ABOVE the shared render/fold core (./liveTrace.mjs) — it owns WHAT messages are
// created/edited/deleted and in what order; the core owns how a tool row/card becomes text. Discord and
// Telegram were near-verbatim copies of this whole file (quality.md #155: that drift is what broke
// WhatsApp), so it lives here once, parameterized by the pieces that genuinely differ per surface:
//
//   - transport   create / edit / remove one message, the reply-reference shape, and the standalone-image
//                 post — each closure receives the adapter instance so it calls the SAME adapter methods
//                 the plugin tests mock (adapter.rest / adapter.tgSend / …).
//   - style       the render style handed to ./liveTrace.mjs, extended with subtext(s) and italic(s) for
//                 the progress bubble's dim lines (Discord `-# …` / `_…_`; plain-text Telegram → identity).
//   - CHUNK/splitContent  the surface's message-size limit and its code-fence-aware splitter.
//   - postWithImages      the final-answer image strategy — genuinely different per surface (Discord
//                 uploads ride the first text chunk; Telegram photos precede the text) → stays per-plugin.
//   - footerLine          the runtime footer (Discord subtext `-# …` vs Telegram `— …`) → stays per-plugin.
import { extractImageRefs, stripThinking } from './format.mjs';
import { resolveDisplaySettings } from './display.mjs';
import { makeTextHelpers, outputFailed, makeOutputSummary, diffSummary, makeFoldedCalls, makeToolLinesFor, makeCardLines } from './liveTrace.mjs';

const EDIT_THROTTLE_MS = 1200; // matched across surfaces — stay under Discord's ~5 edits / 5 s and Telegram's edit rate
/** How long a turn may go with no VISIBLE progress (a new tool call / card) before the `Step N / MAX`
 *  counter surfaces as a "still working" reassurance. Below this it stays hidden; any fresh tool/card
 *  resets the clock and drops it again. Tuned short enough that a slow step never reads as a stuck agent. */
const STALL_HINT_MS = 60_000;
const DIVIDER = '┈┈┈┈┈┈┈┈┈┈'; // separates the tool trace from each display card (wrapped in style.subtext)

/** Build the live-message classes for one surface. Returns the `LiveMessage` class the plugin re-exports;
 *  `EditableMessage`/`StreamingAnswer` stay internal. */
export function createLiveMessage({ transport, style, CHUNK, splitContent, postWithImages, footerLine }) {
  const { compactLine, safeTail } = makeTextHelpers(style);
  const outputSummary = makeOutputSummary({ compactLine, safeTail });
  const foldedCalls = makeFoldedCalls(compactLine);
  const toolLinesFor = makeToolLinesFor({ compactLine, safeTail, style });
  const cardLines = makeCardLines(style);

  /** One editable message: created on the first write (transport.create), then edited in place
   *  (transport.edit) under a throttle. Shared by the tool-progress bubble and the streaming answer.
   *  Callers keep content within the surface's limit (progress slices to CHUNK; the answer pre-splits). */
  class EditableMessage {
    constructor(adapter, channelId, createExtra = {}) {
      this.a = adapter;
      this.channelId = channelId;
      this.createExtra = createExtra; // merged into the FIRST create only (e.g. a reply reference); edits stay plain
      this.messageId = null;
      this.content = '';
      this.sent = null;    // the content the surface last actually received — skip a redundant edit when unchanged
      this.lastEdit = 0;
      this.timer = null;   // a self-rescheduled trailing flush, so the LAST edit always lands even with no further update
      this.sending = null; // the tail of the serialized send chain — a new send always waits for the prior one
      this.finalizing = false; // set by settle() to force one last send past the throttle
      this.closed = false;
    }
    /** Set the full desired content and schedule a (throttled) edit. */
    update(content) {
      this.content = content;
      void this.flush();
    }
    /** Bypass the throttle, settle to a final content exactly once (awaiting the in-flight create/edit chain
     *  first, so no straggler send double-creates), then freeze — no later edit can overwrite it. */
    async settle(content) {
      this.content = content;
      this.finalizing = true;
      await this.flush();
      // The settle is the AUTHORITATIVE final send. If it failed (a 429/network blip left `sent` behind
      // `content`), retry once before freezing — otherwise the reply is silently lost, frozen at the
      // mid-stream draft, with no later drain to retry it (close() below would end the chain).
      if (this.content !== this.sent) await this.flush();
      this.close();
    }
    /** Freeze the message: no further edit lands, and any armed trailing flush is cancelled. */
    close() {
      this.closed = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    }
    /** Schedule a send of the latest content, honoring the throttle. Sends are SERIALIZED through `sending`
     *  so the initial create runs (and sets messageId) before any later edit — a burst never double-posts. */
    flush() {
      if (this.closed) return Promise.resolve();
      const elapsed = Date.now() - this.lastEdit;
      if (!this.finalizing && elapsed < EDIT_THROTTLE_MS) {
        // Inside the throttle window: arm a SINGLE trailing flush so the latest content always lands ~throttle
        // later, even if no further update arrives (coalesces a burst into one edit at the window's end).
        if (!this.timer) {
          this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, EDIT_THROTTLE_MS - elapsed);
          if (typeof this.timer.unref === 'function') this.timer.unref();
        }
        return Promise.resolve();
      }
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.sending = (this.sending ?? Promise.resolve()).then(() => this.drain());
      return this.sending;
    }
    /** One serialized send: create the message the first time (claiming messageId), edit it thereafter. Skips
     *  when the content the surface already has is current, so a coalesced/duplicate flush is a no-op. */
    async drain() {
      if (this.closed) return;
      if (this.content === this.sent) return; // the surface already has the latest content
      this.lastEdit = Date.now();
      const content = this.content;
      if (!this.messageId) {
        this.messageId = await transport.create(this.a, this.channelId, content || '💭 …', this.createExtra);
        if (this.messageId) this.sent = content; // a failed create leaves sent null so the next drain retries the create
      } else {
        // A failed edit (429/network blip) must leave `sent` unchanged so a later drain/settle retries —
        // mirroring the create path, which leaves `sent` null on a failed create. Marking `sent` on failure
        // would freeze the message at the stale draft with no retry (content === sent skips the next drain).
        const ok = await transport.edit(this.a, this.channelId, this.messageId, content);
        if (ok) this.sent = content;
      }
    }
  }

  /** The streaming answer: the assistant's reply text edited live into its OWN message(s), kept SEPARATE
   *  from the tool-progress bubble so alternating text→tool→text never loses an edit target. Overflow past
   *  one message is split code-fence-aware (splitContent) into ordered continuation bubbles; only the last
   *  (growing) one is edited on each delta — earlier ones freeze at their piece. The FIRST bubble is a real
   *  reply to the triggering message. */
  class StreamingAnswer {
    constructor(adapter, channelId, replyToId) {
      this.a = adapter;
      this.channelId = channelId;
      this.replyToId = replyToId; // the first bubble replies to it; continuations are plain
      this.bubbles = [];          // ordered EditableMessages; index 0 carries the reply reference
    }
    bubbleFor(i) {
      let b = this.bubbles[i];
      if (!b) {
        const ref = i === 0 && this.replyToId ? transport.replyRef(this.replyToId) : {};
        b = new EditableMessage(this.a, this.channelId, ref);
        // Serialize the initial create ACROSS bubbles through one linked chain: a new bubble's first send
        // waits for the previous bubble's send chain, so continuation posts land in piece order. Independent
        // per-bubble chains could otherwise transpose pieces (a code-fence continuation posted above its
        // opening part).
        const prev = this.bubbles[i - 1];
        if (prev) b.sending = prev.sending ?? Promise.resolve();
        this.bubbles[i] = b;
      }
      return b;
    }
    /** Stream the growing answer: split code-fence-aware and edit each piece into its bubble. */
    update(text) {
      const pieces = splitContent(text);
      for (let i = 0; i < pieces.length; i++) this.bubbleFor(i).update(pieces[i]);
    }
    /** Settle to the FINAL answer exactly once: each bubble edited to its final piece and frozen. Any extra
     *  continuation bubble left over from a longer streamed draft (the returned reply is shorter) is deleted,
     *  so no stale tail remains. */
    async finalize(text) {
      const pieces = splitContent(text);
      for (let i = 0; i < pieces.length; i++) await this.bubbleFor(i).settle(pieces[i]);
      for (let i = pieces.length; i < this.bubbles.length; i++) await this.deleteBubble(this.bubbles[i]);
    }
    /** Freeze a bubble and delete its message, AWAITING any in-flight create/edit first — a bubble whose
     *  initial create is still in flight has messageId === null, so deciding close-vs-delete before the send
     *  settles would let a straggler create escape and leave an orphan message behind. */
    async deleteBubble(b) {
      b.close();
      await b.sending?.catch(() => {}); // let the in-flight create/edit settle so messageId is known
      if (b.messageId) await transport.remove(this.a, b.channelId, b.messageId);
    }
    /** Delete EVERY posted bubble and freeze — used to drop a stranded answer draft (re-anchored below a
     *  tool trace) or an image-only reply's raw-markdown draft. Awaits each in-flight send so none escapes. */
    async discard() { for (const b of this.bubbles) await this.deleteBubble(b); }
    close() { for (const b of this.bubbles) b.close(); }
  }

  /** One turn with independent presentation axes. Tool calls share one lifecycle bubble keyed by toolCallId;
   *  answer text either streams into separate editable messages or is posted once at finalize. Keeping those
   *  surfaces independent lets the chat feel alive without forcing token-by-token answer noise. */
  class LiveMessage {
    constructor(adapter, channelId, replyToId, askerId, display) {
      this.a = adapter;
      this.channelId = channelId;
      this.replyToId = replyToId; // the triggering message — the answer bubble is a real reply to it
      this.askerId = askerId;     // who to route an AskUserQuestion prompt to (and gate its answer on)
      this.display = display ?? resolveDisplaySettings(adapter.cfg);
      this.toolCalls = []; // lifecycle rows in display order
      this.toolById = new Map(); // PI toolCallId → row (parallel-safe completion/progress updates)
      this.notices = new Map(); // retry/compaction status lines by kind
      this.progress = null; // the tool-trace bubble, created lazily on the first tool event
      this.toolBubbles = new Map(); // per-tool editable bubbles when the conversation opts into per_tool layout
      this.answer = null;   // the live answer bubble(s), created lazily on the first visible text delta
      this.answerStranded = false; // set when the tool bubble is posted BELOW an already-started answer draft →
                                   // the answer is stranded ABOVE the trace and must be re-anchored at finalize
      this.text = '';       // accumulated assistant text — streamed into `answer` and the finalize fallback
      this.imageRefs = [];  // generated-image refs from tool results — attached even if the reply omits them
      this.idle = null;     // the turn's settle event (model + context usage) → runtime footer
      this.reasoning = '';  // reasoning stream, only rendered when cfg.showReasoning (off by default)
      this.cards = new Map(); // latest display cards (ctx.emitCard) by id — the todo checklist is the canonical one
      this.step = 0;        // current agent step (model round-trip) in this run
      this.maxSteps = 0;    // configured ceiling (0 = unlimited / not surfaced)
      this.lastActivityAt = Date.now(); // last VISIBLE progress (tool/card) — the step counter only shows after a stall
      this.stallTimer = null;           // fires once STALL_HINT_MS after the last activity to surface the counter
    }
    /** Re-render the progress bubble in ONE edited message: an optional `Step N / MAX` counter, the tool
     *  trace, an opt-in reasoning tail, then each live display card (todo checklist) as its OWN block set
     *  apart by a thin subtext divider — so the plan never reads as just another tool line. */
    renderProgress() {
      const toolLines = [];
      // The step counter is a STALL hint, not always-on: it surfaces only once the turn has gone
      // STALL_HINT_MS with no new tool/card, so a long step doesn't read as a frozen agent. Fresh
      // progress resets `lastActivityAt` and drops it again.
      if (this.maxSteps > 0 && Date.now() - this.lastActivityAt >= STALL_HINT_MS) {
        toolLines.push(style.subtext(`⚙️ Step ${Math.min(this.step, this.maxSteps)} / ${this.maxSteps}`));
      }
      // In per-tool mode each lifecycle row owns a separate editable message; the aggregate progress
      // bubble is reserved for cards/notices/reasoning so those surfaces remain coherent.
      if (this.display.toolMessageMode !== 'per_tool') {
        for (const call of foldedCalls(this.toolCalls, this.display)) toolLines.push(...toolLinesFor(call, this.display));
      }
      for (const notice of this.notices.values()) toolLines.push(`🔄 ${compactLine(notice, 240)}`);
      if (this.a.cfg?.showReasoning && this.reasoning.trim()) {
        const tail = this.reasoning.trim().slice(-280).replace(/\s+/g, ' ');
        toolLines.push(`💭 ${style.italic(tail)}`);
      }
      // Each card becomes its own section; a subtext divider separates the tool trace from the checklist(s).
      const cards = [...this.cards.values()].map((c) => cardLines(c).join('\n')).filter(Boolean);
      const sections = [];
      if (toolLines.length) sections.push(toolLines.join('\n'));
      sections.push(...cards);
      if (!sections.length) return;
      if (!this.progress) {
        this.progress = new EditableMessage(this.a, this.channelId);
        // The answer draft already started, so this new tool bubble posts BELOW it — stranding the answer
        // ABOVE the trace. Flag it so finalize re-anchors the answer below and keeps it the LAST message.
        if (this.answer) this.answerStranded = true;
      }
      const rendered = sections.join(`\n${style.subtext(DIVIDER)}\n`);
      // Preserve the newest/active tools and cards when a long turn exceeds the surface's message limit.
      const bounded = rendered.length > CHUNK ? `…\n${rendered.slice(-(CHUNK - 2))}` : rendered;
      this.progress.update(bounded);
    }
    renderTool(call) {
      if (this.display.toolMessageMode !== 'per_tool') return;
      const lines = toolLinesFor(call, this.display);
      const content = lines.join('\n');
      let bubble = this.toolBubbles.get(call);
      if (!bubble) {
        bubble = new EditableMessage(this.a, this.channelId);
        this.toolBubbles.set(call, bubble);
        // A tool bubble posted after an answer draft would otherwise leave the final answer above it.
        if (this.answer) this.answerStranded = true;
      }
      bubble.update(content.slice(0, CHUNK));
    }
    /** (Re)arm the stall hint: after STALL_HINT_MS of no visible tool progress, re-render so the step
     *  counter surfaces even during pure silence (one long-running tool emits no interim events). */
    armStallHint() {
      clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => this.renderProgress(), STALL_HINT_MS);
      if (typeof this.stallTimer.unref === 'function') this.stallTimer.unref();
    }
    findTool(id) {
      return id ? this.toolById.get(id) : this.toolCalls[this.toolCalls.length - 1];
    }
    settleTool(id, state = 'done', summary = '', tail = '') {
      const call = this.findTool(id);
      if (!call) return;
      call.state = state;
      call.progress = '';
      if (summary) call.summary = summary;
      if (tail) call.finalTail = tail;
      this.lastActivityAt = Date.now();
      this.armStallHint();
      this.renderTool(call);
      this.renderProgress();
    }
    onEvent(e) {
      if (e.type === 'tool' && e.name) {
        if (this.display.toolActivity === 'off') return;
        const existing = e.id ? this.toolById.get(e.id) : null;
        let call;
        if (existing) {
          call = existing;
          call.detail = e.detail ?? call.detail;
          call.icon = e.icon ?? call.icon;
          call.state = 'running';
        } else {
          call = { id: e.id, name: e.name, detail: e.detail, icon: e.icon, state: 'running', progress: '', summary: '', finalTail: '' };
          this.toolCalls.push(call);
          if (e.id) this.toolById.set(e.id, call);
        }
        this.lastActivityAt = Date.now(); // visible progress → reset the stall clock, hide the step counter
        this.armStallHint();
        this.renderTool(call);
        this.renderProgress();
      } else if (e.type === 'tool_progress' && e.id) {
        const call = this.findTool(e.id);
        if (call && this.display.toolActivity === 'live') {
          call.progress = safeTail(e.text);
          this.lastActivityAt = Date.now();
          this.armStallHint();
          this.renderTool(call);
          this.renderProgress();
        }
      } else if (e.type === 'tool_output') {
        const output = e.output ?? {};
        this.settleTool(e.id, outputFailed(output) ? 'error' : 'done', outputSummary(output), output.fullText ?? output.text);
      } else if (e.type === 'diff') {
        const note = outputSummary(e.output);
        this.settleTool(e.id, outputFailed(e.output) ? 'error' : 'done', note || diffSummary(e.diff), e.diff);
      } else if (e.type === 'tool_end') {
        this.settleTool(e.id, e.isError ? 'error' : 'done');
      } else if (e.type === 'subagent' && e.id) {
        const call = this.findTool(e.id);
        if (call) {
          call.detail = e.detail || e.task || call.detail;
          call.summary = `${e.tools ?? 0} tools · ${e.seconds ?? 0}s`;
          if (e.status !== 'running') call.state = e.status === 'error' ? 'error' : 'done';
          this.lastActivityAt = Date.now(); this.armStallHint(); this.renderProgress();
        }
      } else if (e.type === 'notice' && e.kind) {
        // Notices may annotate an existing work trace, but do not create a standalone bubble that would
        // become stale as soon as the transient notice clears.
        if (!this.progress && this.toolCalls.length === 0 && this.cards.size === 0) return;
        if (e.done) this.notices.delete(e.kind);
        else if (e.message) this.notices.set(e.kind, e.message);
        this.renderProgress();
      } else if (e.type === 'reasoning' && e.delta) {
        // Off by default — reasoning is noise on chat. When cfg.showReasoning is on it rides the progress
        // bubble as a dim tail. Always accumulated so toggling mid-turn has content to show.
        this.reasoning += e.delta;
        if (this.a.cfg?.showReasoning) this.renderProgress();
      } else if (e.type === 'text' && e.delta) {
        this.text += e.delta;
        // Final-answer mode keeps accumulating text for finalize but does not create an editable answer
        // bubble. The live tool trace remains independent and the complete answer lands once below it.
        if (this.display.answerMode !== 'live') return;
        // Stream the growing answer into its OWN message, separate from the tool bubble. Skip pure-thinking
        // deltas (stripThinking) so no empty/placeholder answer is posted while the model is still reasoning.
        const visible = stripThinking(this.text);
        if (visible.trim()) {
          this.answer ??= new StreamingAnswer(this.a, this.channelId, this.replyToId);
          this.answer.update(visible);
        }
      } else if (e.type === 'image' && e.ref) {
        this.imageRefs.push(e.ref);
        this.settleTool(e.id, 'done', 'image ready');
      } else if (e.type === 'card' && e.card?.id) {
        // Upsert the card by id; an empty card (no items/body) removes it. Then re-render the bubble.
        const empty = (!e.card.items || e.card.items.length === 0) && !e.card.body;
        if (empty) this.cards.delete(e.card.id); else this.cards.set(e.card.id, e.card);
        this.lastActivityAt = Date.now(); // a card update is visible progress → reset the stall clock
        this.armStallHint();
        this.renderProgress();
      } else if (e.type === 'step' && e.maxSteps) {
        // A new agent step — update the live counter in the SAME progress bubble (no new message).
        this.step = e.step; this.maxSteps = e.maxSteps;
        this.renderProgress();
      } else if (e.type === 'ask' && Array.isArray(e.questions)) {
        // The turn parked on AskUserQuestion — post the interactive choice message (fire-and-forget; the
        // turn stays blocked in the tool until the user answers via a component/button/text interaction).
        void this.a.postAsk(this.channelId, this.replyToId, this.askerId, e.id, e.questions).catch(() => {});
      } else if (e.type === 'idle') {
        this.idle = e;
      }
    }
    /** Freeze the live bubbles on a FAILED turn: clear the stall-hint timer and close BOTH the progress and
     *  answer messages so a straggler edit can't land after the error reply already went out. */
    abandon() {
      clearTimeout(this.stallTimer);
      if (this.progress) this.progress.close();
      for (const bubble of this.toolBubbles.values()) bubble.close();
      if (this.answer) this.answer.close();
    }
    /** Settle a failed turn's activity before the adapter posts the error reply. */
    async fail(message) {
      clearTimeout(this.stallTimer);
      for (const call of this.toolCalls) if (call.state === 'running') {
        call.state = 'error';
        call.progress = '';
        if (!call.summary) call.summary = compactLine(message, 140);
      }
      this.notices.clear();
      for (const call of this.toolCalls) this.renderTool(call);
      this.renderProgress();
      for (const bubble of this.toolBubbles.values()) await bubble.settle(bubble.content);
      if (this.progress) await this.progress.settle(this.progress.content);
      if (this.answer) this.answer.close();
    }
    async finalize(reply) {
      // Settle the progress bubble to its complete tool list (a throttled edit may still be pending),
      // then freeze it so the straggler timer can't fire afterwards.
      clearTimeout(this.stallTimer);
      for (const call of this.toolCalls) if (call.state === 'running') call.state = 'done';
      this.notices.clear();
      for (const call of this.toolCalls) this.renderTool(call);
      for (const bubble of this.toolBubbles.values()) await bubble.settle(bubble.content);
      if (this.progress) {
        this.lastActivityAt = Date.now(); // drop the stall step-counter from the settled tool trace
        this.renderProgress();
        await this.progress.settle(this.progress.content); // bypass the throttle for this one final settle, then freeze
      }
      // Nothing happened on this message: no streamed tool progress, no assistant text, no live answer, no
      // reply, no image refs. That's the mid-run-injection case — the message was steered into another turn
      // that streams its own bubble — so don't post a "(no response)" placeholder here.
      if (!reply && !this.text && !this.progress && !this.answer && !this.toolBubbles.size && !this.imageRefs.length) return;
      // The answer draft opened BEFORE the tool bubble, so it is stranded ABOVE the now-settled tool trace.
      // Drop it here (awaiting its in-flight send) and null it, so the authoritative reply is (re)posted
      // BELOW the trace — restoring the guarantee that the final answer is the conversation's LAST message.
      if (this.answerStranded && this.answer) { await this.answer.discard(); this.answer = null; }
      // strip any leaked <think> reasoning (vision-fallback models) before it ever reaches the conversation.
      const full = stripThinking(reply || this.text || '(no response)');
      // Generated images this turn produced: links the model repeated in its text PLUS tool-produced refs it
      // forgot to repeat. They go into their OWN message(s). On a non-streamed turn (no live answer) the image
      // is posted BEFORE the text so it reads as a standalone attachment above the footer. When the answer
      // already streamed into its own bubble, the image message follows it (send-time order).
      const { cleaned, files } = extractImageRefs(full);
      const names = new Set(files);
      for (const ref of this.imageRefs) names.add(ref.slice(ref.lastIndexOf('/') + 1));
      let posted = false;
      if (names.size && transport.hasImages(this.a)) {
        const data = this.a.resolveImageFiles([...names]);
        if (data.length) { await transport.postImages(this.a, this.channelId, data).catch(() => {}); posted = true; }
      }
      // Runtime footer (model · context %) rides the text message only, opt-out via config.
      const footer = this.a.cfg?.runtimeFooter !== false ? footerLine(this.idle) : '';
      if (posted) {
        // The images are their own message now — the text reply carries no image markdown. Skip an empty text
        // bubble for an image-only reply (the image message already stands alone as the answer).
        const body = cleaned.trim() ? (footer ? `${cleaned}\n\n${footer}` : cleaned) : '';
        // An image-only reply must NOT freeze the streamed draft (which holds raw, now-dead image markdown):
        // settle the answer bubble to the cleaned caption if there is one, else DELETE the draft entirely so
        // only the standalone image message remains.
        if (this.answer) { if (body) await this.answer.finalize(body); else await this.answer.discard(); }
        else if (body) await postWithImages(this.a, this.channelId, body, this.replyToId).catch(() => {});
      } else {
        // No resolvable images (or a bare test fake) — settle the answer to the full text (the streamed draft
        // is replaced by the authoritative reply), footer appended once to the last bubble.
        const body = footer ? `${full}\n\n${footer}` : full;
        if (this.answer) await this.answer.finalize(body);
        else await postWithImages(this.a, this.channelId, body, this.replyToId).catch(() => {});
      }
    }
  }

  return LiveMessage;
}
