// WhatsApp platform plugin: a Baileys (WhatsApp Web multi-device) client. The bot answers when a
// mapped sender writes to it (direct chat always; in groups on @mention or reply, unless configured to
// answer freely). Each sender — a phone number, a JID, or a whole group JID — resolves via this plugin's
// own senderPolicies config to the Orca projects they may touch plus an optional role prompt. Unmapped
// senders are ignored.
//
// On top of plain chat it provides: text commands (/model, /thinking, /new, /help, /stop, /status,
// /compact, /restart), a per-chat model picker (native buttons with a numbered-text fallback), live
// streaming replies (edit-in-place with a tool-call trace), a typing indicator, status reactions,
// proactive pushes (cron/tick echoes) via notify(), and admin/owner-gated whatsapp_* tools for group
// management and outbound messaging.
//
// Pairing: on first connect the socket emits a QR (rendered as ASCII into the plugin logs + a PNG in the
// data dir) or, when a phoneNumber is configured, an 8-char pairing code. Credentials persist to the
// data dir and are reused across reconnects.
//
// Buttons caveat: native WhatsApp buttons/list are unreliable on personal accounts (often render blank —
// they are really a Business-API feature). Every interactive prompt therefore ALSO carries a readable
// numbered-text body, and the response parser accepts both a button/list reply AND a plain-text number.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers,
  downloadMediaMessage, jidNormalizedUser, jidDecode,
} from 'baileys';
import QRCode from 'qrcode';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ok = (text) => ({ content: [{ type: 'text', text }], details: {} });
const fail = (e) => ok(`Error: ${e instanceof Error ? e.message : String(e)}`);
// Reasoning-effort levels PI accepts for extended-thinking models (mirrors THINKING_LEVELS daemon-side).
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const EDIT_THROTTLE_MS = 1500; // WhatsApp is stricter than Discord on edits — stay well under any limit
/** How long a turn may go with no VISIBLE progress (a new tool call / card) before the `Step N / MAX`
 *  counter surfaces as a "still working" reassurance; any fresh tool/card resets the clock and drops it. */
const STALL_HINT_MS = 60_000;
const CHUNK = 4000;            // split long replies into readable pieces
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // larger inbound images are noted, not downloaded
const MAX_IMAGES = 4;                    // vision cap per message
const ASK_TTL_MS = 6 * 60_000;           // drop a pending ask/menu after this (> the core 5-min timeout)
const MENU_TTL_MS = 6 * 60_000;          // a numbered-menu number-reply is valid this long
const MAX_UPLOAD_IMAGES = 4;             // generated-image uploads per reply
const REPLY_EXCERPT = 300;               // quoted-reply excerpt length

/** Strip inline chain-of-thought (`<think>…</think>` / `<thinking>…</thinking>`) some vision-fallback
 *  models emit into the text stream instead of a separate reasoning channel. Mirrors the daemon's
 *  stripInlineReasoning so the fallback path never leaks reasoning into the visible answer. */
export function stripThinking(text) {
  if (!/<\/?think(?:ing)?\b/i.test(text)) return text;
  let out = text
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  const lead = /^[\s\S]*?<\/think(?:ing)?>/i.exec(out);
  if (lead) out = out.slice(lead[0].length);
  return out.trim();
}

/** Find generated-image markdown links — `![…](…/brain/images/<name>.png)` — and return the text with
 *  them removed plus the extracted file names. The name rule mirrors the daemon's image validation. */
export function extractImageRefs(text) {
  const files = [];
  const cleaned = text.replace(/!\[[^\]]*\]\([^)\s]*\/brain\/images\/([a-z0-9]+\.png)\)/g, (_, name) => {
    files.push(name);
    return '';
  });
  return { cleaned, files };
}

/** Parse a picker exec (`orca:<provider>/<model>`, `<provider>/<model>`, or bare model) into the
 *  brain's model selection shape. */
export function parseModelExec(spec) {
  const s = typeof spec === 'string' ? spec.trim().replace(/^orca:/, '') : '';
  if (!s) return null;
  const slash = s.indexOf('/');
  return slash > 0 ? { provider: s.slice(0, slash), model: s.slice(slash + 1) } : { model: s };
}

/** Digits-only comparison of two WhatsApp identifiers so a policy `roleId` written as a bare number,
 *  a full JID, or with punctuation still matches the sender. Group JIDs (…@g.us) compare by their full
 *  id (which is also digits) — a group's id never collides with a personal number in practice. */
function sameId(a, b) {
  const norm = (x) => String(x ?? '').replace(/[^0-9]/g, '');
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/** Whether a JID is a group chat (…@g.us) rather than a direct chat. */
function isGroup(jid) { return typeof jid === 'string' && jid.endsWith('@g.us'); }

/** The bare phone number of a personal JID (…@s.whatsapp.net / …@lid) — digits only. */
function numberOf(jid) { return jidDecode(jid)?.user ?? String(jid ?? '').replace(/[@:].*$/, ''); }

/** Normalize a user-supplied recipient (number or JID) into a sendable JID. A value already carrying an
 *  @-suffix is trusted as-is (group or user); a bare number becomes a personal JID. */
function toJid(recipient) {
  const s = String(recipient ?? '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  return `${s.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
}

/** Whether any of the sender's identifiers maps to a policy flagged `admin: true` — the operator.
 *  Gates the shared per-chat pickers (/model, /thinking) and the group tools. */
export function senderIsAdmin(ids, policies) {
  const list = Array.isArray(policies) ? policies : [];
  return list.some((p) => p.roleId && p.admin === true && ids.some((id) => sameId(p.roleId, id)));
}

/** Quote context for a reply: who is being answered + a capped excerpt of what they said. */
export function buildReplyContext(name, body) {
  const content = String(body ?? '').trim();
  if (!content) return '';
  const excerpt = content.length > REPLY_EXCERPT ? `${content.slice(0, REPLY_EXCERPT)}…` : content;
  return `[Replying to ${name || 'someone'}: "${excerpt}"]`;
}

/** Split text into ≤CHUNK pieces WITHOUT breaking a fenced code block: if a cut lands inside ``` … ```,
 *  close the fence on this piece and reopen it (same language) on the next. Prefers newline cuts. */
export function splitContent(text) {
  const pieces = [];
  let rest = String(text ?? '');
  let reopen = '';
  while (rest.length > CHUNK) {
    let cut = rest.lastIndexOf('\n', CHUNK);
    if (cut < CHUNK * 0.5) cut = CHUNK; // no good newline → hard cut
    let piece = reopen + rest.slice(0, cut);
    rest = rest.slice(cut);
    const fences = piece.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) {
      const lang = /```([^\n`]*)\n[^]*$/.exec(piece)?.[1] ?? '';
      piece += '\n```';
      reopen = '```' + lang + '\n';
    } else {
      reopen = '';
    }
    pieces.push(piece);
  }
  pieces.push(reopen + rest);
  return pieces;
}

/** User-facing service messages, per configured language (config `language`: 'en' | 'cs'). These are
 *  the bot's own texts (command replies, placeholders) — the brain's answers are in the user's language. */
const MESSAGES = {
  en: {
    newConversation: '🆕 Fresh conversation started in this chat.',
    noModels: '❌ No models configured yet (Settings → Orca AI).',
    pickModel: '🧠 Pick the model for this chat',
    modelSet: (m) => `✅ Model set to *${m}*.`,
    modelForbidden: '🔒 Only the operator can change the model here.',
    pickThinking: '🧠 Pick the reasoning effort for this chat',
    thinkingSet: (l) => `✅ Reasoning effort set to *${l}*.`,
    controlForbidden: '🔒 Only the operator can control the agent here.',
    stopped: '⏹️ Stopped the running agent.',
    nothingRunning: '💤 Nothing is running in this chat.',
    noSession: '💤 No active conversation in this chat yet.',
    status: (model, pct, tokens) => `🧠 *${model}*\n📊 Context ${pct}% · ${tokens} tokens`,
    compacted: (pct) => `🗜️ Context compacted — now at ${pct}%.`,
    nothingToCompact: '✅ Nothing to compact yet — the context is still small.',
    compactFailed: '⚠️ Compaction failed — check the logs.',
    restarting: '🔄 Restarting the Orca daemon…',
    restartForbidden: '🔒 Only an admin can restart the daemon.',
    restartUnavailable: '⚠️ Restart isn’t available on this deployment.',
    replyWithNumber: (n) => n > 1 ? `Reply with a number (1-${n}).` : 'Reply with the number.',
    submitHint: 'Reply *submit* when done, or send your own answer as text.',
    expired: '⏱ This prompt expired.',
    otherHint: 'Or just type your own answer.',
    help: (name) => [
      `*${name} on WhatsApp*`,
      'Write to me and I answer.',
      '',
      '`/model` — pick the AI model for this chat',
      '`/thinking` — set the reasoning effort for this chat',
      '`/new` — start a fresh conversation here',
      '`/stop` — stop the running agent',
      '`/status` — model, context and usage',
      '`/compact` — summarize to free up context',
      '`/restart` — restart the Orca daemon (admin)',
      '`/help` — this message',
    ].join('\n'),
  },
  cs: {
    newConversation: '🆕 V tomto chatu začíná nová konverzace.',
    noModels: '❌ Zatím nejsou nastavené žádné modely (Nastavení → Orca AI).',
    pickModel: '🧠 Vyberte model pro tento chat',
    modelSet: (m) => `✅ Model nastaven na *${m}*.`,
    modelForbidden: '🔒 Model tady může měnit jen provozovatel.',
    pickThinking: '🧠 Vyberte úroveň uvažování pro tento chat',
    thinkingSet: (l) => `✅ Úroveň uvažování nastavena na *${l}*.`,
    controlForbidden: '🔒 Agenta tady může řídit jen provozovatel.',
    stopped: '⏹️ Zastavil jsem běžícího agenta.',
    nothingRunning: '💤 V tomto chatu nic neběží.',
    noSession: '💤 V tomto chatu zatím není žádná aktivní konverzace.',
    status: (model, pct, tokens) => `🧠 *${model}*\n📊 Kontext ${pct}% · ${tokens} tokenů`,
    compacted: (pct) => `🗜️ Kontext sesumarizován — nyní na ${pct}%.`,
    nothingToCompact: '✅ Zatím není co sumarizovat — kontext je ještě malý.',
    compactFailed: '⚠️ Sumarizace selhala — zkontroluj logy.',
    restarting: '🔄 Restartuji Orca daemon…',
    restartForbidden: '🔒 Restartovat daemon může jen admin.',
    restartUnavailable: '⚠️ Restart není na tomto nasazení dostupný.',
    replyWithNumber: (n) => n > 1 ? `Odpověz číslem (1-${n}).` : 'Odpověz tím číslem.',
    submitHint: 'Až budeš hotov, napiš *submit*, nebo pošli vlastní odpověď textem.',
    expired: '⏱ Tento dotaz vypršel.',
    otherHint: 'Nebo napiš vlastní odpověď.',
    help: (name) => [
      `*${name} na WhatsAppu*`,
      'Napiš mi a odpovím.',
      '',
      '`/model` — výběr AI modelu pro tento chat',
      '`/thinking` — úroveň uvažování pro tento chat',
      '`/new` — začít novou konverzaci',
      '`/stop` — zastavit běžícího agenta',
      '`/status` — model, kontext a využití',
      '`/compact` — sesumarizovat a uvolnit kontext',
      '`/restart` — restart Orca daemonu (admin)',
      '`/help` — tato zpráva',
    ].join('\n'),
  },
};

/** Per-chat state: chosen model + a conversation "generation" (/new bumps it → fresh session). */
class StateStore {
  constructor(file) { this.file = file; this.cache = null; }
  all() {
    if (this.cache) return this.cache;
    try { this.cache = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf-8')) : {}; }
    catch { this.cache = {}; }
    return this.cache;
  }
  get(chatId) { return this.all()[chatId] ?? {}; }
  patch(chatId, fields) {
    const all = this.all();
    all[chatId] = { ...all[chatId], ...fields };
    this.cache = all;
    try { writeFileSync(this.file, JSON.stringify(all, null, 2)); } catch { /* best-effort persistence */ }
  }
}

/** A minimal pino-shaped logger Baileys accepts, forwarding only warn/error to Orca's logger (trace/
 *  debug/info are dropped — Baileys is extremely chatty). Baileys calls `child()` and pino-style
 *  `(obj, msg)` signatures, so both are tolerated. */
function pinoShim(log) {
  const fmt = (args) => args.map((x) => {
    try { return typeof x === 'string' ? x : (x?.message ?? JSON.stringify(x)); } catch { return String(x); }
  }).join(' ');
  const shim = {
    level: 'warn',
    child: () => shim,
    trace: () => {}, debug: () => {}, info: () => {},
    warn: (...a) => log.warn?.(`baileys: ${fmt(a)}`),
    error: (...a) => log.error?.(`baileys: ${fmt(a)}`),
    fatal: (...a) => log.error?.(`baileys: ${fmt(a)}`),
  };
  return shim;
}

/** Runtime footer: `model · 42 %`. Empty when the idle event carried no usable data. */
export function footerLine(idle) {
  const parts = [];
  const model = typeof idle?.model === 'string' ? idle.model.split('/').pop() : '';
  if (model) parts.push(model);
  const pct = idle?.usage?.percent;
  if (typeof pct === 'number' && pct >= 0) parts.push(`${Math.round(pct)} %`);
  return parts.length ? `_${parts.join(' · ')}_` : '';
}

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

function rolePrompt(policy) {
  const parts = [];
  if (policy.name) parts.push(`The user you are talking to has the "${policy.name}" role.`);
  if (policy.prompt) parts.push(policy.prompt);
  return parts.join('\n') || undefined;
}

class WhatsAppAdapter {
  name = 'whatsapp';
  constructor(cfg, logger, state, listModels, imageDirs, authDir, qrPngPath, answerQuestion) {
    this.cfg = cfg;
    this.log = logger;
    this.plog = pinoShim(logger); // pino-shaped logger for Baileys internals
    this.state = state;
    this.listModels = listModels;
    this.imageDirs = imageDirs;
    this.authDir = authDir;
    this.qrPngPath = qrPngPath;
    this.answerQuestion = answerQuestion;
    this.handler = null;
    this.ctl = null;
    this.sock = null;
    this.stopped = false;
    this.meId = null;        // our normalized JID (for self-message + mention detection)
    this.authState = null;
    this.saveCreds = null;
    this.pairingRequested = false;
    this.reconnectTimer = null;
    this.backoffMs = 2000;   // reconnect backoff, grows to a ceiling and resets on a clean open
    this.lastQr = null;      // most recent pairing QR string
    this.lastQrDataUrl = null; // …rendered to a PNG data URL for the Pair modal
    this.lastPairingCode = null; // most recent phone pairing code (phoneNumber flow)
    this.lastQrLogAt = 0;    // throttle the ASCII-QR log line
    this.sentStore = new Map(); // messageId → sent proto message (for getMessage retries + edits)
    this.pendingAsks = new Map(); // askId → { jid, askerJid, questions, selected, awaitingText, key, createdAt }
    this.pendingMenus = new Map(); // jid → { kind:'model'|'thinking', options:[{n,id,label}], createdAt }
    this.msg = MESSAGES[cfg.language === 'cs' ? 'cs' : 'en'];
  }

  listen(onMessage) { this.handler = onMessage; }
  control(api) { this.ctl = api; }

  /** The chat conversation reference for commands: same identity onMessage reports (chat id folded
   *  with the /new generation), so a command targets the exact session a message would. */
  chatRef(jid) { return { platform: 'whatsapp', channelId: `${jid}#${this.state.get(jid).gen ?? 0}` }; }

  /** Live pairing snapshot for the Pair modal: the current QR (as a PNG data URL), the phone pairing
   *  code, and whether the device is already linked. Read by GET /plugins/whatsapp/pairing. */
  getPairing() {
    return { qrImage: this.meId ? null : (this.lastQrDataUrl ?? null), code: this.meId ? null : (this.lastPairingCode ?? null), connected: !!this.meId };
  }

  /** Force a fresh pairing attempt (the Pair button): wipe any stale/half-written credentials so Baileys
   *  mints a brand-new QR (and phone pairing code) instead of hanging trying to resume a dead session,
   *  then re-open the socket. A no-op once the device is already linked. */
  async startPairing() {
    if (this.meId) return { connected: true };
    // Reset the auth state to empty BEFORE reconnecting, so the reconnect starts a clean pairing.
    try { rmSync(this.authDir, { recursive: true, force: true }); mkdirSync(this.authDir, { recursive: true }); } catch { /* best-effort */ }
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.authState = state; this.saveCreds = saveCreds;
    this.pairingRequested = false; // let onQr mint a fresh phone pairing code
    this.lastPairingCode = null; this.lastQr = null; this.lastQrDataUrl = null;
    this.backoffMs = 2000;
    // With a fresh authState in place, the 'close' handler's reconnect (or a direct start) yields a new QR.
    if (this.sock) { try { this.sock.end(undefined); } catch { /* 'close' handler reconnects */ } }
    else { await this.startSocket(); }
    return { connected: false };
  }

  /** Unlink the device (the red "Unpair" button): log out on WhatsApp's side so the phone drops the
   *  linked device, wipe the local credentials, and drop back to the unpaired state (a fresh QR can then
   *  be requested via startPairing). */
  async unpair() {
    try { await this.sock?.logout(); } catch { /* may already be unlinked/offline */ }
    try { rmSync(this.authDir, { recursive: true, force: true }); mkdirSync(this.authDir, { recursive: true }); } catch { /* best-effort */ }
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.authState = state; this.saveCreds = saveCreds;
    this.meId = null; this.pairingRequested = false;
    this.lastQr = null; this.lastQrDataUrl = null; this.lastPairingCode = null;
    try { this.sock?.end?.(undefined); } catch { /* logout() may have already closed it */ }
    return { connected: false };
  }

  async connect() {
    this.stopped = false;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.authState = state;
    this.saveCreds = saveCreds;
    await this.startSocket();
  }

  /** Build (or rebuild) the Baileys socket and wire its events. Reused on every reconnect with the same
   *  persisted auth state, so a reconnect never re-pairs. */
  async startSocket() {
    if (this.stopped) return;
    const sock = makeWASocket({
      auth: this.authState,
      logger: this.plog,
      browser: Browsers.ubuntu('Orca'),
      markOnlineOnConnect: false, // don't suppress the phone's own notifications
      getMessage: async (key) => this.sentStore.get(key.id) ?? undefined,
    });
    this.sock = sock;
    sock.ev.on('creds.update', this.saveCreds);
    sock.ev.on('connection.update', (u) => void this.onConnectionUpdate(u).catch((e) => this.log.error(`connection update failed: ${e?.message ?? e}`)));
    sock.ev.on('messages.upsert', (up) => void this.onUpsert(up).catch((e) => this.log.error(`message handling failed: ${e?.message ?? e}`)));
  }

  async onConnectionUpdate(u) {
    const { connection, lastDisconnect, qr } = u;
    if (qr) await this.onQr(qr);
    if (connection === 'open') {
      this.meId = this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
      this.lastQr = null; this.lastQrDataUrl = null; this.lastPairingCode = null; // paired — nothing to show
      this.backoffMs = 2000;
      this.log.info(`whatsapp connected as ${this.sock.user?.id ?? '?'}`);
    }
    if (connection === 'close') {
      if (this.stopped) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      // `loggedOut` (401) BEFORE we ever registered just means the pairing window lapsed — DON'T wipe
      // creds or spam a new pairing code; back off and retry. Only a logout on an already-registered
      // device is a genuine unlink that must clear the dead credentials.
      const wasRegistered = !!this.authState?.creds?.registered;
      if (code === DisconnectReason.loggedOut && wasRegistered) {
        this.log.warn('whatsapp logged out — clearing credentials, re-pair required');
        try { rmSync(this.authDir, { recursive: true, force: true }); mkdirSync(this.authDir, { recursive: true }); } catch { /* best-effort */ }
        const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
        this.authState = state; this.saveCreds = saveCreds;
        this.pairingRequested = false; // allow a fresh pairing code on the next attempt
        this.backoffMs = 2000;
      }
      // Reconnect with exponential backoff (capped) so an unpaired socket can't hammer the API.
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => void this.startSocket().catch((e) => this.log.error(`reconnect failed: ${e?.message ?? e}`)), delay);
    }
  }

  /** Surface a pairing QR: stash it for the Pair modal, drop a PNG in the data dir, and log a scannable
   *  ASCII copy (throttled). A pairing code (phone-number flow) is requested ONCE per plugin run — never
   *  a fresh code on every reconnect, which is what previously hammered the logs/API. */
  async onQr(qr) {
    this.lastQr = qr;
    try { await QRCode.toFile(this.qrPngPath, qr, { width: 512 }); } catch { /* ignore */ }
    try { this.lastQrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 1 }); } catch { /* ignore */ }
    if (this.cfg.phoneNumber && !this.authState?.creds?.registered && !this.pairingRequested) {
      this.pairingRequested = true;
      const num = String(this.cfg.phoneNumber).replace(/[^0-9]/g, '');
      try {
        const codeStr = await this.sock.requestPairingCode(num);
        this.lastPairingCode = codeStr;
        this.log.info(`whatsapp pairing code for +${num}: ${codeStr}  → WhatsApp → Linked devices → Link with phone number`);
      } catch (e) {
        this.log.error(`pairing code request failed, use the QR instead: ${e?.message ?? e}`);
      }
      return;
    }
    const now = Date.now();
    if (now - this.lastQrLogAt > 25_000) {
      this.lastQrLogAt = now;
      try {
        const ascii = await QRCode.toString(qr, { type: 'terminal', small: true });
        this.log.info(`whatsapp pairing QR — scan it in WhatsApp → Linked devices:\n${ascii}`);
      } catch { /* ignore ASCII render failure */ }
    }
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    try { this.sock?.end?.(undefined); } catch { /* already closed */ }
  }

  // ── access resolution ──

  /** The identifiers a sender is known by, for policy matching: their personal number/JID plus (in a
   *  group) the group JID — so a policy can grant a whole group at once. */
  senderIds(senderJid, chatJid) {
    const ids = [senderJid, numberOf(senderJid)];
    if (isGroup(chatJid)) ids.push(chatJid);
    return ids.filter(Boolean);
  }

  /** Resolve a sender to an access descriptor (policy → projects/prompt + per-chat model). Returns
   *  `access: undefined` for an unmapped sender → the turn is dropped silently. */
  accessFor(senderJid, chatJid) {
    const ids = this.senderIds(senderJid, chatJid);
    const policies = Array.isArray(this.cfg.senderPolicies) ? this.cfg.senderPolicies : [];
    const match = policies.find((p) => p.roleId && ids.some((id) => sameId(p.roleId, id)));
    if (!match) return { ids, access: undefined };
    const st = this.state.get(chatJid);
    const chosen = st.model;
    return {
      ids,
      access: {
        admin: match.admin === true,
        projectIds: (match.projectIds ?? []).map(Number),
        prompt: rolePrompt(match),
        model: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
        thinkingLevel: typeof st.thinkingLevel === 'string' ? st.thinkingLevel : undefined,
        tools: Array.isArray(match.tools) && match.tools.length > 0 ? match.tools : undefined,
      },
    };
  }

  // ── inbound ──

  async onUpsert(up) {
    if (up.type !== 'notify') return; // 'append' = history sync; only act on genuinely new messages
    for (const m of up.messages ?? []) {
      await this.onMessage(m).catch((e) => this.log.error(`message failed: ${e?.message ?? e}`));
    }
  }

  async onMessage(m) {
    if (!this.handler || !m.message || m.key?.fromMe) return;
    const chatJid = m.key.remoteJid;
    if (!chatJid || chatJid === 'status@broadcast') return;
    const group = isGroup(chatJid);
    // Baileys 7 LID addressing: `remoteJid`/`participant` may be an internal `…@lid` id, with the real
    // phone-number JID in the `…Alt` field. Prefer the phone-number JID so sender policies (written as
    // phone numbers) match, and so the sender identity is stable.
    const lidSender = group ? (m.key.participant || m.participant || '') : chatJid;
    const pnSender = group ? (m.key.participantAlt || '') : (m.key.remoteJidAlt || '');
    const senderJid = pnSender || lidSender;
    if (!senderJid) return;
    if (m.message) this.sentStore.set(m.key.id, m.message); // cache for getMessage retries

    const rawText = this.extractText(m.message);

    // Free-text answer to a parked ask_user_question ("other"), or a numbered reply to a pending menu.
    if (await this.handleTextReply(chatJid, senderJid, rawText, m)) return;

    // Group allowlist: when configured, only respond inside these groups.
    if (group) {
      const allowed = new Set(String(this.cfg.groupIds ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      if (allowed.size > 0 && !allowed.has(chatJid)) return;
    }

    const { access } = this.accessFor(senderJid, chatJid);
    if (!access) return; // unmapped sender → stay silent

    // Group mention gate: unless configured to answer freely, respond only on @mention or a reply to us.
    if (group && this.cfg.respondWithoutMention === false && !this.isForMe(m)) return;

    let text = this.stripMention(rawText);
    const { images, notes } = await this.collectMedia(m);
    if (notes.length) text = [text, ...notes].filter(Boolean).join('\n');
    if (!text && images.length) text = '[The user sent an image]';
    if (!text) return;

    // A slash command targets the bot's controls, not the brain.
    if (text.startsWith('/') && await this.handleCommand(chatJid, senderJid, text)) return;

    const senderName = m.pushName || numberOf(senderJid);
    const replyCtx = buildReplyContext(this.quotedName(m), this.quotedText(m));
    const prefixed = `${replyCtx ? `${replyCtx}\n` : ''}[${senderName}] ${text}`;

    const gen = this.state.get(chatJid).gen ?? 0;
    const convoKey = `${chatJid}#${gen}`;

    const reactions = this.cfg.reactions !== false;
    const streaming = this.cfg.streaming !== false;
    const stream = streaming ? new LiveMessage(this, chatJid, m, senderJid) : null;
    const onEvent = stream
      ? (e) => stream.onEvent(e)
      : (e) => { if (e.type === 'ask' && Array.isArray(e.questions)) void this.postAsk(chatJid, m, senderJid, e.id, e.questions).catch(() => {}); };

    const typing = setInterval(() => void this.sock.sendPresenceUpdate('composing', chatJid).catch(() => {}), 8000);
    void this.sock.sendPresenceUpdate('composing', chatJid).catch(() => {});
    if (reactions) void this.react(m.key, '👀').catch(() => {});

    const vision = images.length ? parseModelExec(this.cfg.visionModel) : null;
    const turnAccess = vision ? { ...access, model: vision } : access;

    try {
      const reply = await this.handler(
        {
          platform: 'whatsapp', userId: senderJid, userName: senderName, roleIds: [senderJid],
          channelId: convoKey, access: turnAccess,
          channelName: group ? await this.groupSubject(chatJid) : undefined,
          images: images.length ? images : undefined,
        },
        prefixed,
        onEvent,
      );
      clearInterval(typing);
      void this.sock.sendPresenceUpdate('paused', chatJid).catch(() => {});
      if (stream) await stream.finalize(reply);
      else if (reply) await this.sendText(chatJid, stripThinking(reply), m);
      if (reactions) void this.react(m.key, '✅').catch(() => {});
    } catch (e) {
      clearInterval(typing);
      void this.sock.sendPresenceUpdate('paused', chatJid).catch(() => {});
      if (reactions) void this.react(m.key, '❌').catch(() => {});
      await this.sendText(chatJid, `⚠️ ${e?.message ?? e}`, m).catch(() => {});
    }
  }

  /** Extract display text from a message content union (plain, extended, or a media caption). */
  extractText(content) {
    return (
      content?.conversation
      ?? content?.extendedTextMessage?.text
      ?? content?.imageMessage?.caption
      ?? content?.videoMessage?.caption
      ?? content?.documentMessage?.caption
      ?? ''
    ).trim();
  }

  /** Whether a group message is addressed to the bot: an @mention of us, or a reply to one of our
   *  messages. Only consulted when respondWithoutMention is off. */
  isForMe(m) {
    if (!this.meId) return true; // not yet known → don't drop
    const ctx = m.message?.extendedTextMessage?.contextInfo;
    const mentioned = (ctx?.mentionedJid ?? []).some((j) => sameId(j, this.meId));
    const repliedToMe = ctx?.participant ? sameId(ctx.participant, this.meId) : false;
    return mentioned || repliedToMe;
  }

  /** Remove a leading/embedded @<ournumber> mention token from the text. */
  stripMention(text) {
    if (!this.meId) return text;
    const num = numberOf(this.meId);
    return String(text ?? '').replaceAll(`@${num}`, '').replace(/\s+/g, ' ').trim();
  }

  quotedName(m) {
    const ctx = m.message?.extendedTextMessage?.contextInfo;
    if (!ctx?.quotedMessage) return '';
    return ctx.participant ? numberOf(ctx.participant) : '';
  }
  quotedText(m) {
    const q = m.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    return q ? this.extractText(q) : '';
  }

  /** Download an inbound image (base64, capped) for vision; other media becomes a textual note. */
  async collectMedia(m) {
    const images = [];
    const notes = [];
    const img = m.message?.imageMessage;
    if (img) {
      const size = Number(img.fileLength ?? 0);
      if (size && size > MAX_IMAGE_BYTES) {
        notes.push('[Attachment: image (too large to read)]');
      } else if (images.length < MAX_IMAGES) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: this.plog, reuploadRequest: this.sock.updateMediaMessage });
          images.push({ data: Buffer.from(buf).toString('base64'), mimeType: img.mimetype || 'image/jpeg' });
        } catch (e) { notes.push('[Attachment: image (download failed)]'); this.log.error(`image download failed: ${e?.message ?? e}`); }
      }
    }
    if (m.message?.audioMessage) notes.push('[Attachment: voice message (audio — not transcribed)]');
    if (m.message?.documentMessage) notes.push(`[Attachment: ${m.message.documentMessage.fileName ?? 'document'}]`);
    if (m.message?.videoMessage && !m.message.videoMessage.caption) notes.push('[Attachment: video]');
    return { images, notes };
  }

  // ── pending menus & prompts (all text-driven — WhatsApp native buttons are unreliable on personal
  //    accounts, so pickers are numbered text menus the user replies to with a number) ──

  /** Apply a numbered-menu pick id (`model:*`, `think:*`) — resolved from a numeric text reply. */
  async handleSelection(chatJid, senderJid, id, m) {
    if (id.startsWith('model:')) {
      const ids = this.senderIds(senderJid, chatJid);
      if (!senderIsAdmin(ids, this.cfg.senderPolicies)) { await this.sendText(chatJid, this.msg.modelForbidden, m); return true; }
      const [, provider] = id.split(':');
      const [prov, mod] = [provider, id.slice(`model:${provider}:`.length)];
      if (prov && mod) { this.state.patch(chatJid, { model: { provider: prov, model: mod } }); await this.sendText(chatJid, this.msg.modelSet(mod), m); }
      this.pendingMenus.delete(chatJid);
      return true;
    }
    if (id.startsWith('think:')) {
      const ids = this.senderIds(senderJid, chatJid);
      if (!senderIsAdmin(ids, this.cfg.senderPolicies)) { await this.sendText(chatJid, this.msg.modelForbidden, m); return true; }
      const v = id.slice('think:'.length);
      const level = v === 'default' ? '' : (THINKING_LEVELS.includes(v) ? v : '');
      this.state.patch(chatJid, { thinkingLevel: level });
      await this.sendText(chatJid, this.msg.thinkingSet(level || 'default'), m);
      this.pendingMenus.delete(chatJid);
      return true;
    }
    return false;
  }

  /** Resolve a text reply against a pending prompt: a numeric pick on a model/thinking menu, or an
   *  answer to a parked ask (a number picks that option on a single-question ask; `submit` delivers;
   *  anything else is a free-form answer). Returns true when the message was consumed. */
  async handleTextReply(chatJid, senderJid, text, m) {
    const t = String(text ?? '').trim();
    // Parked ask_user_question from this sender.
    for (const [id, pend] of this.pendingAsks) {
      if (Date.now() - pend.createdAt > ASK_TTL_MS) { this.pendingAsks.delete(id); continue; }
      if (pend.jid !== chatJid || !sameId(pend.askerJid, senderJid)) continue;
      if (/^submit$/i.test(t)) { await this.submitAsk(id, m); return true; }
      // A bare number on a single-question ask picks that option and submits immediately.
      if (pend.questions.length === 1) {
        const opts = pend.questions[0].options ?? [];
        const n = Number(t);
        if (Number.isInteger(n) && n >= 1 && n <= opts.length) {
          pend.selected[0] = [opts[n - 1].label];
          await this.submitAsk(id, m);
          return true;
        }
      }
      // Otherwise treat the text as a free-form ("other") answer to the first question.
      if (t) {
        const q0 = pend.questions[0];
        const settled = this.answerQuestion(id, [{ header: q0.header, selected: pend.selected[0] ?? [], other: t }]);
        this.pendingAsks.delete(id);
        if (settled) return true; // answer delivered — the model's reply is the acknowledgement, no ack line
      }
    }
    // Numeric reply to a pending model/thinking menu.
    const menu = this.pendingMenus.get(chatJid);
    if (menu) {
      if (Date.now() - menu.createdAt > MENU_TTL_MS) { this.pendingMenus.delete(chatJid); return false; }
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= menu.options.length) {
        const opt = menu.options[n - 1];
        return this.handleSelection(chatJid, senderJid, opt.id, m);
      }
    }
    return false;
  }

  /** Render a numbered text menu the user replies to with a number, and register a pending entry so the
   *  reply resolves. `options`: [{ id, label, description? }]. */
  async sendMenu(chatJid, kind, title, options, quoted) {
    const opts = options.slice(0, 20);
    const lines = opts.map((o, i) => `${i + 1}. *${o.label}*${o.description ? ` — ${o.description}` : ''}`);
    const body = `${title}\n\n${lines.join('\n')}\n\n_${this.msg.replyWithNumber(opts.length)}_`;
    this.pendingMenus.set(chatJid, { kind, options: opts.map((o, i) => ({ n: i + 1, id: o.id, label: o.label })), createdAt: Date.now() });
    await this.sendText(chatJid, body, quoted);
  }

  // ── ask_user_question ──

  /** Render a parked ask_user_question (brain `ask` event) as a numbered text prompt. On a single-question
   *  ask the user replies with a number (or free text); multi-question asks collect a free-text answer or
   *  `submit`. Answers are delivered from handleTextReply. */
  async postAsk(chatJid, quoted, askerJid, id, questions) {
    const qs = questions.slice(0, 4);
    const blocks = qs.map((q) => {
      const opts = (q.options ?? []).slice(0, 20).map((op, oi) => `  ${oi + 1}. ${op.label}${op.description ? ` — ${op.description}` : ''}`);
      return `*${q.header}* — ${q.question}\n${opts.join('\n')}`;
    });
    const single = qs.length === 1;
    const hint = single ? this.msg.replyWithNumber((qs[0].options ?? []).length) : this.msg.submitHint;
    const body = `❓ ${blocks.join('\n\n')}\n\n_${hint}_`;
    this.pendingAsks.set(id, { jid: chatJid, askerJid, questions: qs, selected: {}, createdAt: Date.now() });
    const key = await this.sendText(chatJid, body, quoted);
    const pend = this.pendingAsks.get(id);
    if (pend) pend.key = key;
  }

  async submitAsk(id, m) {
    const pend = this.pendingAsks.get(id);
    if (!pend) return;
    const answers = pend.questions.map((q, qi) => ({ header: q.header, selected: pend.selected[qi] ?? [] }));
    const settled = this.answerQuestion(id, answers);
    this.pendingAsks.delete(id);
    if (!settled) await this.sendText(pend.jid, this.msg.expired, m); // only warn if it timed out; success needs no ack
  }

  // ── commands ──

  /** Handle a `/command`. Returns true when the text was a (recognized) command. */
  async handleCommand(chatJid, senderJid, text) {
    const [cmd] = text.slice(1).split(/\s+/);
    const admin = () => senderIsAdmin(this.senderIds(senderJid, chatJid), this.cfg.senderPolicies);
    switch (cmd.toLowerCase()) {
      case 'help':
        await this.sendText(chatJid, this.msg.help('Orca'));
        return true;
      case 'new': {
        const gen = (this.state.get(chatJid).gen ?? 0) + 1;
        this.state.patch(chatJid, { gen });
        await this.sendText(chatJid, this.msg.newConversation);
        return true;
      }
      case 'model': {
        if (!admin()) { await this.sendText(chatJid, this.msg.modelForbidden); return true; }
        const models = (await this.listModels().catch(() => [])).slice(0, 20);
        if (!models.length) { await this.sendText(chatJid, this.msg.noModels); return true; }
        const options = models.map((mo) => ({ id: `model:${mo.provider}:${mo.model}`, label: mo.model, description: mo.providerLabel }));
        await this.sendMenu(chatJid, 'model', this.msg.pickModel, options);
        return true;
      }
      case 'thinking': {
        if (!admin()) { await this.sendText(chatJid, this.msg.modelForbidden); return true; }
        const options = [{ id: 'think:default', label: 'default', description: 'model default' }, ...THINKING_LEVELS.map((lv) => ({ id: `think:${lv}`, label: lv }))];
        await this.sendMenu(chatJid, 'thinking', this.msg.pickThinking, options);
        return true;
      }
      case 'stop': case 'status': case 'compact': {
        if (!admin()) { await this.sendText(chatJid, this.msg.controlForbidden); return true; }
        if (!this.ctl) { await this.sendText(chatJid, this.msg.noSession); return true; }
        const ref = this.chatRef(chatJid);
        if (cmd.toLowerCase() === 'stop') {
          const st = this.ctl.status(ref);
          if (!st?.streaming) { await this.sendText(chatJid, this.msg.nothingRunning); return true; }
          this.ctl.abort(ref);
          await this.sendText(chatJid, this.msg.stopped);
          return true;
        }
        if (cmd.toLowerCase() === 'status') {
          const st = this.ctl.status(ref);
          await this.sendText(chatJid, st ? this.msg.status(st.model, st.usage.percent ?? 0, st.usage.tokens ?? 0) : this.msg.noSession);
          return true;
        }
        try {
          const res = await this.ctl.compact(ref);
          await this.sendText(chatJid, !res ? this.msg.noSession : (res.compacted ? this.msg.compacted(res.usage.percent ?? 0) : this.msg.nothingToCompact));
        } catch { await this.sendText(chatJid, this.msg.compactFailed); }
        return true;
      }
      case 'restart': {
        if (!admin()) { await this.sendText(chatJid, this.msg.restartForbidden); return true; }
        if (!this.ctl) { await this.sendText(chatJid, this.msg.restartUnavailable); return true; }
        try { await this.ctl.restart(); await this.sendText(chatJid, this.msg.restarting); }
        catch { await this.sendText(chatJid, this.msg.restartUnavailable); }
        return true;
      }
      default:
        return false; // unknown /word → treat as a normal message
    }
  }

  // ── outbound helpers ──

  /** Send text, split into ≤CHUNK pieces (fence-safe); the first piece quotes `quoted` when given. */
  async sendText(chatJid, text, quoted) {
    const pieces = splitContent(text);
    let firstKey = null;
    for (let i = 0; i < pieces.length; i++) {
      const sent = await this.sock.sendMessage(chatJid, { text: pieces[i] }, i === 0 && quoted ? { quoted } : {});
      if (i === 0) firstKey = sent?.key ?? null;
      if (sent?.key && sent.message) this.sentStore.set(sent.key.id, sent.message);
    }
    return firstKey;
  }

  /** Send generated images as image messages (the first optionally quoting the trigger). */
  async sendImages(chatJid, files, quoted) {
    for (let i = 0; i < files.length; i++) {
      await this.sock.sendMessage(chatJid, { image: files[i].data }, i === 0 && quoted ? { quoted } : {}).catch(() => {});
    }
  }

  react(key, emoji) { return this.sock.sendMessage(key.remoteJid, { react: { text: emoji, key } }); }

  /** Load up to MAX_UPLOAD_IMAGES generated images by validated name from the image plugins' data dirs. */
  resolveImageFiles(names) {
    const files = [];
    for (const name of names.slice(0, MAX_UPLOAD_IMAGES)) {
      for (const dir of this.imageDirs) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        try { files.push({ name, data: readFileSync(p) }); } catch { /* unreadable → skip */ }
        break;
      }
    }
    return files;
  }

  async groupSubject(jid) {
    try { return (await this.sock.groupMetadata(jid))?.subject || undefined; } catch { return undefined; }
  }

  /** Host-initiated push (cron/tick echoes) → the configured notification chat. No-op without one. */
  async notify(text, chatId) {
    const target = (typeof chatId === 'string' && chatId.trim()) || (typeof this.cfg.notifyChat === 'string' ? this.cfg.notifyChat.trim() : '');
    if (!target || !this.sock) return;
    await this.sendText(toJid(target), text);
  }

  /** The live socket, or a thrown error when not yet connected — used by the whatsapp_* tools. */
  requireSock() {
    if (!this.sock || !this.meId) throw new Error('WhatsApp is not connected yet — pair the device first (see the plugin logs for the QR / pairing code)');
    return this.sock;
  }
}

export function register(ctx) {
  const dataDir = ctx.dataDir();
  const state = new StateStore(join(dataDir, 'channel-state.json'));
  const authDir = join(dataDir, 'auth');
  try { mkdirSync(authDir, { recursive: true }); } catch { /* exists */ }
  // The image-gen/image-edit plugins are data-dir siblings — their generated PNGs upload from there.
  const imageDirs = [join(dataDir, '..', 'image-gen'), join(dataDir, '..', 'image-edit')];
  const adapter = new WhatsAppAdapter({ ...ctx.config }, ctx.logger, state, ctx.listModels, imageDirs, authDir, join(dataDir, 'qr.png'), ctx.answerQuestion);
  ctx.registerPlatform(adapter);

  const adminGate = () => { if (!ctx.isAdminSession()) throw new Error('available only in an admin session'); };

  // Send a message to any chat — OWNER only (it can message anyone the account can reach).
  ctx.registerTool(defineTool({
    name: 'whatsapp_send', label: 'WhatsApp send message',
    description: 'Send a WhatsApp text message to a chat: a phone number in international format (e.g. 420777123456), a user JID (…@s.whatsapp.net) or a group JID (…@g.us). Operator only.',
    parameters: Type.Object({
      to: Type.String({ description: 'Recipient: phone number, user JID or group JID' }),
      text: Type.String({ description: 'Message text' }),
    }),
    execute: async (_id, p) => {
      try {
        if (ctx.currentIdentity?.()?.owner !== true) throw new Error('whatsapp_send is only available to the operator');
        const sock = adapter.requireSock();
        const jid = toJid(p.to);
        if (!jid) return ok('Error: no recipient.');
        await sock.sendMessage(jid, { text: String(p.text ?? '') });
        return ok(`Sent to ${jid}.`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'whatsapp_group_list', label: 'List WhatsApp groups',
    description: 'List the groups the bot is a participant of (JID, subject, member count) so you can pick one to inspect or message.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const groups = await sock.groupFetchAllParticipating();
        const lines = Object.values(groups ?? {}).map((g) => `${g.id}  ${g.subject ?? ''}  (${g.participants?.length ?? 0} members)`);
        return ok(lines.join('\n') || '(no groups)');
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'whatsapp_group_info', label: 'WhatsApp group info',
    description: 'Details of one group by JID (…@g.us): subject, description, owner and the participant list (JID + admin flag).',
    parameters: Type.Object({ groupJid: Type.String({ description: 'Group JID (…@g.us)' }) }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const g = await sock.groupMetadata(p.groupJid);
        const members = (g.participants ?? []).map((m) => `${m.id}${m.admin ? `  [${m.admin}]` : ''}`);
        return ok([
          `id: ${g.id}`, `subject: ${g.subject ?? ''}`,
          g.desc ? `desc: ${g.desc}` : null, g.owner ? `owner: ${g.owner}` : null,
          `participants (${members.length}):`, ...members,
        ].filter(Boolean).join('\n'));
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'whatsapp_group_create', label: 'Create WhatsApp group',
    description: 'Create a WhatsApp group with a subject and initial members (phone numbers or JIDs). Returns the new group JID.',
    parameters: Type.Object({
      subject: Type.String({ description: 'Group name' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to add' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        if (!jids.length) return ok('Error: at least one member is required.');
        const g = await sock.groupCreate(String(p.subject ?? 'Group'), jids);
        return ok(`Created group ${g.id} "${g.subject ?? p.subject}".`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'whatsapp_group_add', label: 'Add WhatsApp group member',
    description: 'DESTRUCTIVE. Add members (phone numbers or JIDs) to a group by JID. The bot must be a group admin.',
    parameters: Type.Object({
      groupJid: Type.String({ description: 'Group JID (…@g.us)' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to add' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        const res = await sock.groupParticipantsUpdate(p.groupJid, jids, 'add');
        return ok(`add → ${JSON.stringify(res)}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'whatsapp_group_remove', label: 'Remove WhatsApp group member',
    description: 'DESTRUCTIVE. Remove members (phone numbers or JIDs) from a group by JID. The bot must be a group admin.',
    parameters: Type.Object({
      groupJid: Type.String({ description: 'Group JID (…@g.us)' }),
      members: Type.Array(Type.String(), { description: 'Phone numbers or user JIDs to remove' }),
    }),
    execute: async (_id, p) => {
      try {
        adminGate();
        const sock = adapter.requireSock();
        const jids = (p.members ?? []).map(toJid).filter(Boolean);
        const res = await sock.groupParticipantsUpdate(p.groupJid, jids, 'remove');
        return ok(`remove → ${JSON.stringify(res)}`);
      } catch (e) { return fail(e); }
    },
  }));

  ctx.logger.info('whatsapp platform registered (text commands + model picker + streaming + group tools)');
}
