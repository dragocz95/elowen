// Streaming/edit-throttle machinery: the live progress message and the final-answer sending.
import { CHUNK, stripThinking, extractImageRefs, footerLine } from './format.mjs';

const EDIT_THROTTLE_MS = 1500; // WhatsApp is stricter than Discord on edits — stay well under any limit
/** How long a turn may go with no VISIBLE progress (a new tool call / card) before the `Step N / MAX`
 *  counter surfaces as a "still working" reassurance; any fresh tool/card resets the clock and drops it. */
const STALL_HINT_MS = 60_000;

/** One rendered progress line: `<icon> \`tool\`` + optional `: "detail"` + optional ` ×N` counter. */
function toolLine(c) {
  return `${c.icon ?? '🔧'} \`${c.name}\`` + (c.detail ? `: "${c.detail}"` : '…') + (c.count > 1 ? ` ×${c.count}` : '');
}

/** A display card (ctx.emitCard) for the progress message — title + checklist + freeform body. */
function cardLines(card, max = 15) {
  const items = Array.isArray(card?.items) ? card.items : [];
  const glyph = (s) => (s === 'completed' ? '✅' : s === 'in_progress' ? '🔸' : '⬜');
  const done = items.filter((t) => t.status === 'completed').length;
  const lines = [];
  if (card?.title || items.length) lines.push(`📋 *${card?.title ?? 'Card'}*${items.length ? ` (${done}/${items.length})` : ''}`);
  for (const t of items.slice(0, max)) lines.push(`${glyph(t.status)} ${t.text}`);
  if (items.length > max) lines.push(`… +${items.length - max}`);
  if (card?.body) lines.push(String(card.body));
  return lines;
}

/** One editable WhatsApp message: created on the first write, then edited in place (throttled). Shared
 *  by the tool-progress bubble and — indirectly — the streaming answer. */
class EditableMessage {
  constructor(adapter, jid) {
    this.a = adapter;
    this.jid = jid;
    this.key = null;
    this.content = '';
    this.lastEdit = 0;
    this.pending = false;
  }
  update(content) { this.content = content.slice(0, CHUNK); void this.flush(); }
  async flush() {
    if (this.closed) return; // finalized elsewhere — a straggler edit must not overwrite the final text
    const now = Date.now();
    if (now - this.lastEdit < EDIT_THROTTLE_MS) { this.pending = true; return; }
    this.lastEdit = now;
    try {
      if (!this.key) {
        const s = await this.a.sock.sendMessage(this.jid, { text: this.content || '💭 …' });
        this.key = s?.key ?? null;
      } else {
        await this.a.sock.sendMessage(this.jid, { text: this.content, edit: this.key });
      }
    } catch { /* edit window closed / socket blip — the final message still goes out separately */ }
    if (this.pending) { this.pending = false; setTimeout(() => void this.flush(), EDIT_THROTTLE_MS); }
  }
}

/** Streaming turn: tool calls go into ONE edited progress message (one emoji-tagged line per tool,
 *  consecutive repeats collapsed to ×N), and the final answer is sent as its own clean message AFTER
 *  the run settles, quoted to the trigger. Mirrors the Discord adapter's LiveMessage. */
export class LiveMessage {
  constructor(adapter, jid, quoted, askerJid) {
    this.a = adapter;
    this.jid = jid;
    this.quoted = quoted;     // the triggering message — the final answer quotes it
    this.askerJid = askerJid; // who to route an ask_user_question prompt to (and gate its answer on)
    this.toolCalls = [];
    this.progress = null;
    this.text = '';
    this.imageRefs = [];
    this.idle = null;
    this.reasoning = '';
    this.cards = new Map();
    this.step = 0;
    this.maxSteps = 0;
    this.lastActivityAt = Date.now(); // last VISIBLE progress (tool/card) — the step counter only shows after a stall
    this.stallTimer = null;           // fires once STALL_HINT_MS after the last activity to surface the counter
  }
  renderProgress() {
    const toolLines = [];
    // The step counter is a STALL hint, not always-on: it surfaces only once the turn has gone
    // STALL_HINT_MS with no new tool/card, so a long step doesn't read as a frozen agent. Fresh
    // progress resets `lastActivityAt` and drops it again.
    if (this.maxSteps > 0 && Date.now() - this.lastActivityAt >= STALL_HINT_MS) {
      toolLines.push(`⚙️ Step ${Math.min(this.step, this.maxSteps)} / ${this.maxSteps}`);
    }
    toolLines.push(...this.toolCalls.map(toolLine));
    if (this.a.cfg?.showReasoning && this.reasoning.trim()) {
      const tail = this.reasoning.trim().slice(-280).replace(/\s+/g, ' ');
      toolLines.push(`💭 _${tail}_`);
    }
    const cards = [...this.cards.values()].map((c) => cardLines(c).join('\n')).filter(Boolean);
    const sections = [];
    if (toolLines.length) sections.push(toolLines.join('\n'));
    sections.push(...cards);
    if (!sections.length) return;
    this.progress ??= new EditableMessage(this.a, this.jid);
    this.progress.update(sections.join('\n┈┈┈┈┈┈┈┈┈┈\n'));
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
        if (e.detail) last.detail = e.detail;
      } else {
        this.toolCalls.push({ name: e.name, detail: e.detail, icon: e.icon, count: 1 });
      }
      this.lastActivityAt = Date.now(); // visible progress → reset the stall clock, hide the step counter
      this.armStallHint();
      this.renderProgress();
    } else if (e.type === 'reasoning' && e.delta) {
      this.reasoning += e.delta;
      if (this.a.cfg?.showReasoning) this.renderProgress();
    } else if (e.type === 'text' && e.delta) {
      this.text += e.delta;
    } else if (e.type === 'image' && e.ref) {
      this.imageRefs.push(e.ref);
    } else if (e.type === 'card' && e.card?.id) {
      const empty = (!e.card.items || e.card.items.length === 0) && !e.card.body;
      if (empty) this.cards.delete(e.card.id); else this.cards.set(e.card.id, e.card);
      this.lastActivityAt = Date.now(); // a card update is visible progress → reset the stall clock
      this.armStallHint();
      this.renderProgress();
    } else if (e.type === 'step' && e.maxSteps) {
      this.step = e.step; this.maxSteps = e.maxSteps;
      this.renderProgress();
    } else if (e.type === 'ask' && Array.isArray(e.questions)) {
      void this.a.postAsk(this.jid, this.quoted, this.askerJid, e.id, e.questions).catch(() => {});
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
    clearTimeout(this.stallTimer);
    if (this.progress) {
      this.lastActivityAt = Date.now(); // drop the stall step-counter from the settled tool trace
      this.renderProgress();
      this.progress.lastEdit = 0; // bypass the throttle for the final settle
      await this.progress.flush();
      this.progress.closed = true;
    }
    // Nothing happened here (mid-run steer into another turn) — don't post a placeholder.
    if (!reply && !this.text && !this.progress && !this.imageRefs.length) return;
    const full = stripThinking(reply || this.text || '(no response)');
    const { cleaned, files } = extractImageRefs(full);
    const names = new Set(files);
    for (const ref of this.imageRefs) names.add(ref.slice(ref.lastIndexOf('/') + 1));
    const data = names.size ? this.a.resolveImageFiles([...names]) : [];
    // Generated images go out FIRST as their own image messages (dead /brain/images links are stripped).
    if (data.length) await this.a.sendImages(this.jid, data, this.quoted).catch(() => {});
    const footer = this.a.cfg?.runtimeFooter !== false ? footerLine(this.idle) : '';
    const bodyText = cleaned.trim() ? cleaned : (data.length ? '' : full);
    const body = bodyText ? (footer ? `${bodyText}\n\n${footer}` : bodyText) : '';
    if (body) await this.a.sendText(this.jid, body, data.length ? undefined : this.quoted).catch(() => {});
  }
}
