// Streaming/edit-throttle machinery: the live progress bubble and the final-answer posting.
import { CHUNK, extractImageRefs, splitContent, stripThinking, footerLine } from './format.mjs';
import { resolveDisplaySettings } from './display.mjs';

const EDIT_THROTTLE_MS = 1200; // Discord allows ~5 edits / 5 s per channel — stay under it
/** How long a turn may go with no VISIBLE progress (a new tool call / card) before the `Step N / MAX`
 *  counter surfaces as a "still working" reassurance. Below this it stays hidden; any fresh tool/card
 *  resets the clock and drops it again. Tuned short enough that a slow step never reads as a stuck agent. */
const STALL_HINT_MS = 60_000;

/** Post a final text to a channel. Generated-image links become real Discord file uploads (their
 *  relative daemon URLs are dead text on Discord): the links are stripped and the files ride the
 *  FIRST chunk of the (possibly split) message. Text without image links — or an adapter without
 *  image dirs (tests use bare fakes) — keeps the plain JSON path. */
export async function postWithImages(adapter, channelId, text, replyToId) {
  const { cleaned, files } = extractImageRefs(text);
  const data = typeof adapter.resolveImageFiles === 'function' ? adapter.resolveImageFiles(files) : [];
  const out = data.length ? (cleaned.trim() || '🎨') : text; // nothing loadable → keep the original text
  const pieces = splitContent(out);
  // The first piece is a real Discord reply to the triggering message (fail_if_not_exists:false —
  // a deleted trigger degrades to a plain message instead of a 400).
  const ref = replyToId ? { message_reference: { message_id: replyToId, fail_if_not_exists: false } } : {};
  for (let i = 0; i < pieces.length; i++) {
    if (i === 0 && data.length) await adapter.uploadImages(channelId, pieces[i], data, 0, i === 0 ? ref : {});
    else await adapter.rest('POST', `/channels/${channelId}/messages`, { content: pieces[i], ...(i === 0 ? ref : {}) });
  }
}

/** One editable Discord message: created on the first write, then PATCHed (throttled — Discord allows
 *  ~5 edits / 5 s per channel). Shared by the tool-progress bubble and the streaming answer. Callers keep
 *  content within Discord's limit (progress slices to CHUNK; the answer pre-splits with splitContent). */
class EditableMessage {
  constructor(adapter, channelId, createExtra = {}) {
    this.a = adapter;
    this.channelId = channelId;
    this.createExtra = createExtra; // merged into the FIRST POST only (e.g. a reply reference); PATCHes stay plain
    this.messageId = null;
    this.content = '';
    this.sent = null;    // the content Discord last actually received — skip a redundant edit when unchanged
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
   *  first, so no straggler POST double-creates), then freeze — no later edit can overwrite it. */
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
  /** One serialized send: POST the message the first time (claiming messageId), PATCH it thereafter. Skips
   *  when the content Discord already has is current, so a coalesced/duplicate flush is a no-op. */
  async drain() {
    if (this.closed) return;
    if (this.content === this.sent) return; // Discord already has the latest content
    this.lastEdit = Date.now();
    const content = this.content;
    if (!this.messageId) {
      const msg = await this.a.rest('POST', `/channels/${this.channelId}/messages`, { content: content || '💭 …', ...this.createExtra }).catch(() => null);
      this.messageId = msg?.id ?? null;
      if (this.messageId) this.sent = content; // a failed POST leaves sent null so the next drain retries the create
    } else {
      // A failed PATCH (429/network blip) must leave `sent` unchanged so a later drain/settle retries —
      // mirroring the POST path, which leaves `sent` null on a failed create. Marking `sent` on failure
      // would freeze the message at the stale draft with no retry (content === sent skips the next drain).
      const ok = await this.a.rest('PATCH', `/channels/${this.channelId}/messages/${this.messageId}`, { content }).then(() => true, () => false);
      if (ok) this.sent = content;
    }
  }
}

/** The streaming answer: the assistant's reply text edited live into its OWN Discord message(s), kept in a
 *  message SEPARATE from the tool-progress bubble so alternating text→tool→text never loses an edit target.
 *  Overflow past one Discord message is split code-fence-aware (splitContent) into ordered continuation
 *  bubbles; only the last (growing) one is edited on each delta — earlier ones freeze at their piece. The
 *  FIRST bubble is a real reply to the triggering message. */
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
      const ref = i === 0 && this.replyToId ? { message_reference: { message_id: this.replyToId, fail_if_not_exists: false } } : {};
      b = new EditableMessage(this.a, this.channelId, ref);
      // Serialize the initial create ACROSS bubbles through one linked chain: a new bubble's first send
      // waits for the previous bubble's send chain, so continuation POSTs land on Discord in piece order.
      // Independent per-bubble chains could otherwise transpose pieces (a code-fence continuation posted
      // above its opening part).
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
  /** Settle to the FINAL answer exactly once: each bubble PATCHed to its final piece and frozen. Any extra
   *  continuation bubble left over from a longer streamed draft (the returned reply is shorter) is deleted,
   *  so no stale tail remains. */
  async finalize(text) {
    const pieces = splitContent(text);
    for (let i = 0; i < pieces.length; i++) await this.bubbleFor(i).settle(pieces[i]);
    for (let i = pieces.length; i < this.bubbles.length; i++) await this.deleteBubble(this.bubbles[i]);
  }
  /** Freeze a bubble and delete its Discord message, AWAITING any in-flight create/edit first — a
   *  bubble whose initial POST is still in flight has messageId === null, so deciding close-vs-delete
   *  before the send settles would let a straggler POST escape and leave an orphan message behind. */
  async deleteBubble(b) {
    b.close();
    await b.sending?.catch(() => {}); // let the in-flight create/edit settle so messageId is known
    if (b.messageId) await this.a.rest('DELETE', `/channels/${b.channelId}/messages/${b.messageId}`).catch(() => {});
  }
  /** Delete EVERY posted bubble and freeze — used to drop a stranded answer draft (re-anchored below a
   *  tool trace) or an image-only reply's raw-markdown draft. Awaits each in-flight send so none escapes. */
  async discard() { for (const b of this.bubbles) await this.deleteBubble(b); }
  close() { for (const b of this.bubbles) b.close(); }
}

/** One rendered progress line: `<icon> \`tool\`` + optional `: "detail"` + optional ` ×N` counter. The
 *  icon is resolved daemon-side (core map + plugin manifest `icons`) and rides the `tool` event; the
 *  generic wrench is the fallback when a tool declared none. */
function compactLine(value, max = 180) {
  const line = String(value ?? '')
    .replace(/@(?=everyone|here)/gi, '@\u200b')
    .replace(/<@(?=[!&]?\d)/g, '<@\u200b')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function safeTail(value, max = 600) {
  const clean = String(value ?? '')
    .replace(/\u001b(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|.)?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/```/g, "'''")
    .replace(/@(?=everyone|here)/gi, '@\u200b')
    .replace(/<@(?=[!&]?\d)/g, '<@\u200b')
    .trim();
  return clean.length > max ? `…${clean.slice(clean.length - max + 1)}` : clean;
}

function outputFailed(output) {
  return output?.tone === 'warning' || output?.tone === 'danger' || /(?:needs attention|exit [1-9]\d*)/i.test(output?.status ?? '');
}

function outputSummary(output) {
  const notes = Array.isArray(output?.notes) ? output.notes.filter(Boolean) : [];
  const status = compactLine(output?.status);
  const text = safeTail(output?.text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
  return compactLine(notes.at(-1) ?? (status && !/^(?:ok|done|exit 0)$/i.test(status) ? status : text) ?? '');
}

function diffSummary(diff) {
  const lines = String(diff ?? '').split('\n');
  const added = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ') || 'updated';
}

/** One tool row plus optional bounded output. The tool icon carries the visual identity; completion is
 *  expressed by the compact result text rather than a second status icon before it. */
function toolLinesFor(c, display) {
  let line = `${c.icon ?? '🔧'} \`${c.name}\``;
  if (c.detail) line += `: "${compactLine(c.detail, 100)}"`;
  if (c.count > 1) line += ` ×${c.count}`;
  if (display.toolOutput !== 'hidden' && c.summary) line += ` — ${compactLine(c.summary)}`;
  if (c.state === 'error' && !c.summary) line += ' — failed';
  const lines = [line];
  if (display.toolOutput === 'hidden') return lines;
  // Mid-run output is exclusive to live activity. A settled rolling tail is still useful with status
  // activity, while summary mode already carries its one-line result on the main row.
  const output = c.state === 'running'
    ? (display.toolActivity === 'live' ? c.progress : '')
    : (display.toolOutput === 'tail' ? c.finalTail : '');
  if (!output) return lines;
  const safe = safeTail(output);
  if (!safe) return lines;
  if (display.toolOutput === 'summary') lines.push(`-# ↳ ${compactLine(safe.split('\n').at(-1), 220)}`);
  else lines.push(...safe.split('\n').slice(-6).map((part) => `> ${part || ' '}`));
  return lines;
}

/** A display card (ctx.emitCard) for the progress bubble — title + checklist (emoji per status, since
 *  Discord has no task-list markdown) + freeform body. Capped so a long card can't blow the ~2k limit. */
function cardLines(card, max = 15) {
  const items = Array.isArray(card?.items) ? card.items : [];
  const glyph = (s) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🔸' : '⬜');
  const done = items.filter((t) => t.status === 'completed').length;
  const lines = [];
  if (card?.title || items.length) lines.push(`📋 **${card?.title ?? 'Card'}**${items.length ? ` (${done}/${items.length})` : ''}`);
  for (const t of items.slice(0, max)) lines.push(`${glyph(t.status)} ${t.status === 'completed' ? `~~${t.text}~~` : t.text}`);
  if (items.length > max) lines.push(`… +${items.length - max}`);
  if (card?.body) lines.push(String(card.body));
  return lines;
}

/** One turn with independent presentation axes. Tool calls share one lifecycle bubble keyed by toolCallId;
 *  answer text either streams into separate editable messages or is posted once at finalize. Keeping those
 *  surfaces independent lets Discord feel alive without forcing token-by-token answer noise. */
export class LiveMessage {
  constructor(adapter, channelId, replyToId, askerId, display) {
    this.a = adapter;
    this.channelId = channelId;
    this.replyToId = replyToId; // the triggering message — the answer bubble is a real reply to it
    this.askerId = askerId;     // who to route an ask_user_question prompt to (and gate its answer on)
    this.display = display ?? resolveDisplaySettings(adapter.cfg);
    this.toolCalls = []; // lifecycle rows in display order
    this.toolById = new Map(); // PI toolCallId → row (parallel-safe completion/progress updates)
    this.notices = new Map(); // retry/compaction status lines by kind
    this.progress = null; // the tool-trace bubble, created lazily on the first tool event
    this.toolBubbles = new Map(); // per-tool editable bubbles when the channel opts into per_tool layout
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
      toolLines.push(`-# ⚙️ Step ${Math.min(this.step, this.maxSteps)} / ${this.maxSteps}`);
    }
    // In per-tool mode each lifecycle row owns a separate editable message; the aggregate progress
    // bubble is reserved for cards/notices/reasoning so those surfaces remain coherent.
    if (this.display.toolMessageMode !== 'per_tool') {
      for (const call of this.toolCalls) toolLines.push(...toolLinesFor(call, this.display));
    }
    for (const notice of this.notices.values()) toolLines.push(`🔄 ${compactLine(notice, 240)}`);
    if (this.a.cfg?.showReasoning && this.reasoning.trim()) {
      const tail = this.reasoning.trim().slice(-280).replace(/\s+/g, ' ');
      toolLines.push(`💭 _${tail}_`);
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
    const rendered = sections.join('\n-# ┈┈┈┈┈┈┈┈┈┈\n');
    // Preserve the newest/active tools and cards when a long turn exceeds Discord's message limit.
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
      const last = this.toolCalls[this.toolCalls.length - 1];
      let call;
      if (existing) {
        call = existing;
        call.detail = e.detail ?? call.detail;
        call.icon = e.icon ?? call.icon;
        call.state = 'running';
      } else if (!e.id && last && last.name === e.name && last.state === 'running') {
        last.count += 1;
        if (e.detail) last.detail = e.detail; // latest detail wins on a collapsed line
        call = last;
      } else {
        call = { id: e.id, name: e.name, detail: e.detail, icon: e.icon, count: 1, state: 'running', progress: '', summary: '', finalTail: '' };
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
      // Off by default — reasoning is noise on Discord. When cfg.showReasoning is on it rides the
      // progress bubble as a dim tail. Always accumulated so toggling mid-turn has content to show.
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
      // The turn parked on ask_user_question — post the interactive choice message (fire-and-forget; the
      // turn stays blocked in the tool until the user answers via a component/text interaction).
      void this.a.postAsk(this.channelId, this.replyToId, this.askerId, e.id, e.questions).catch(() => {});
    } else if (e.type === 'idle') {
      this.idle = e;
    }
  }
  /** Freeze the live bubbles on a FAILED turn: clear the stall-hint timer and close BOTH the progress and
   *  answer messages so a straggler edit can't land after the ❌ + ⚠️ error reply already went out. */
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
    // BELOW the trace — restoring the guarantee that the final answer is the channel's LAST message.
    if (this.answerStranded && this.answer) { await this.answer.discard(); this.answer = null; }
    // strip any leaked <think> reasoning (vision-fallback models) before it ever reaches the channel.
    const full = stripThinking(reply || this.text || '(no response)');
    // Generated images this turn produced: links the model repeated in its text PLUS tool-produced refs it
    // forgot to repeat. They go into their OWN message. On a non-streamed turn (no live answer) the image is
    // posted BEFORE the text so it reads as a standalone attachment above the footer. When the answer already
    // streamed into its own bubble, the image message follows it (send-time order).
    const { cleaned, files } = extractImageRefs(full);
    const names = new Set(files);
    for (const ref of this.imageRefs) names.add(ref.slice(ref.lastIndexOf('/') + 1));
    let posted = false;
    if (names.size && typeof this.a.resolveImageFiles === 'function' && typeof this.a.uploadImages === 'function') {
      const data = this.a.resolveImageFiles([...names]);
      if (data.length) { await this.a.uploadImages(this.channelId, '', data, 0, {}).catch(() => {}); posted = true; }
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
