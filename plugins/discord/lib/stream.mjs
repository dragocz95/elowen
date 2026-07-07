// Streaming/edit-throttle machinery: the live progress bubble and the final-answer posting.
import { CHUNK, extractImageRefs, splitContent, stripThinking, footerLine } from './format.mjs';

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
 *  ~5 edits / 5 s per channel). Shared by the tool-progress bubble and the streaming answer. */
class EditableMessage {
  constructor(adapter, channelId) {
    this.a = adapter;
    this.channelId = channelId;
    this.messageId = null;
    this.content = '';
    this.lastEdit = 0;
    this.pending = false;
  }
  /** Set the full desired content and schedule a (throttled) edit. */
  update(content) {
    this.content = content.slice(0, CHUNK);
    void this.flush();
  }
  async flush() {
    if (this.closed) return; // finalized elsewhere — a straggler edit must not overwrite the final text
    const now = Date.now();
    if (now - this.lastEdit < EDIT_THROTTLE_MS) { this.pending = true; return; }
    this.lastEdit = now;
    if (!this.messageId) {
      const msg = await this.a.rest('POST', `/channels/${this.channelId}/messages`, { content: this.content || '💭 …' }).catch(() => null);
      this.messageId = msg?.id ?? null;
    } else {
      await this.a.rest('PATCH', `/channels/${this.channelId}/messages/${this.messageId}`, { content: this.content }).catch(() => {});
    }
    if (this.pending) { this.pending = false; setTimeout(() => void this.flush(), EDIT_THROTTLE_MS); }
  }
}

/** One rendered progress line: `<icon> \`tool\`` + optional `: "detail"` + optional ` ×N` counter. The
 *  icon is resolved daemon-side (core map + plugin manifest `icons`) and rides the `tool` event; the
 *  generic wrench is the fallback when a tool declared none. */
function toolLine(c) {
  return `${c.icon ?? '🔧'} \`${c.name}\`` + (c.detail ? `: "${c.detail}"` : '…') + (c.count > 1 ? ` ×${c.count}` : '');
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

/** Streaming turn: tools go into ONE edited progress bubble — one emoji-tagged line per
 *  tool, joined by single newlines so they stack tightly; CONSECUTIVE repeats of the same tool collapse
 *  into a ×N counter on their line (latest detail shown) — and the final answer is posted as its own
 *  clean message AFTER the run settles. Text deltas are working narration between tool calls; they are
 *  not streamed into the channel, so the answer is always the LAST message (the summary), never buried
 *  under a tool trace. No tools → just the answer. */
export class LiveMessage {
  constructor(adapter, channelId, replyToId, askerId) {
    this.a = adapter;
    this.channelId = channelId;
    this.replyToId = replyToId; // the triggering message — the final answer is a real reply to it
    this.askerId = askerId;     // who to route an ask_user_question prompt to (and gate its answer on)
    this.toolCalls = []; // { name, detail?, count } — one entry per rendered line
    this.progress = null; // created lazily on the first tool event
    this.text = '';       // accumulated only as the finalize fallback (handler may return undefined)
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
    toolLines.push(...this.toolCalls.map(toolLine));
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
    this.progress ??= new EditableMessage(this.a, this.channelId);
    this.progress.update(sections.join('\n-# ┈┈┈┈┈┈┈┈┈┈\n'));
  }
  /** (Re)arm the stall hint: after STALL_HINT_MS of no visible tool progress, re-render so the step
   *  counter surfaces even during pure silence (one long-running tool emits no interim events). */
  armStallHint() {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => this.renderProgress(), STALL_HINT_MS);
    if (typeof this.stallTimer.unref === 'function') this.stallTimer.unref();
  }
  onEvent(e) {
    if (e.type === 'tool' && e.name) {
      const last = this.toolCalls[this.toolCalls.length - 1];
      if (last && last.name === e.name) {
        last.count += 1;
        if (e.detail) last.detail = e.detail; // latest detail wins on a collapsed line
      } else {
        this.toolCalls.push({ name: e.name, detail: e.detail, icon: e.icon, count: 1 });
      }
      this.lastActivityAt = Date.now(); // visible progress → reset the stall clock, hide the step counter
      this.armStallHint();
      this.renderProgress();
    } else if (e.type === 'reasoning' && e.delta) {
      // Off by default — reasoning is noise on Discord. When cfg.showReasoning is on it rides the
      // progress bubble as a dim tail. Always accumulated so toggling mid-turn has content to show.
      this.reasoning += e.delta;
      if (this.a.cfg?.showReasoning) this.renderProgress();
    } else if (e.type === 'text' && e.delta) {
      this.text += e.delta;
    } else if (e.type === 'image' && e.ref) {
      this.imageRefs.push(e.ref);
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
  /** Freeze the live bubble on a FAILED turn: clear the stall-hint timer and close the progress message
   *  so a straggler "⚙️ Step N" edit can't land after the ❌ + ⚠️ error reply already went out. */
  abandon() {
    clearTimeout(this.stallTimer);
    if (this.progress) this.progress.closed = true;
  }
  async finalize(reply) {
    // Settle the progress bubble to its complete tool list (a throttled edit may still be pending),
    // then freeze it so the straggler timer can't fire afterwards.
    clearTimeout(this.stallTimer);
    if (this.progress) {
      this.lastActivityAt = Date.now(); // drop the stall step-counter from the settled tool trace
      this.renderProgress();
      this.progress.lastEdit = 0; // bypass the throttle for this one final settle
      await this.progress.flush();
      this.progress.closed = true;
    }
    // Nothing happened on this message: no streamed tool progress, no assistant text, no reply, no image
    // refs. That's the mid-run-injection case — the message was steered into another turn that streams its
    // own bubble — so don't post a "(no response)" placeholder here.
    if (!reply && !this.text && !this.progress && !this.imageRefs.length) return;
    // strip any leaked <think> reasoning (vision-fallback models) before it ever reaches the channel.
    const full = stripThinking(reply || this.text || '(no response)');
    // Generated images this turn produced: links the model repeated in its text PLUS tool-produced refs
    // it forgot to repeat. They go into their OWN message posted BEFORE the final text, so the artifact
    // reads as a standalone attachment ABOVE the agent's status/footer line — not a file pinned under the
    // usage stats. Discord orders messages by send time, so posting the image first puts it on top.
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
      // The images are their own message now — the text reply carries no image markdown. Skip an empty
      // text bubble for an image-only reply (the image message already stands alone as the answer).
      const body = cleaned.trim() ? (footer ? `${cleaned}\n\n${footer}` : cleaned) : '';
      if (body) await postWithImages(this.a, this.channelId, body, this.replyToId).catch(() => {});
    } else {
      // No resolvable images (or a bare test fake) — post the full text (postWithImages still handles any
      // image markdown itself), footer appended, exactly as before.
      const body = footer ? `${full}\n\n${footer}` : full;
      await postWithImages(this.a, this.channelId, body, this.replyToId).catch(() => {});
    }
  }
}
