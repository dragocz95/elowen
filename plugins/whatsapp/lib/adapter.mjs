// The WhatsApp adapter: Baileys connection/pairing management, the inbound message pipeline,
// text commands, numbered menus/asks and outbound sending.
import {
  makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers,
  downloadMediaMessage, jidNormalizedUser,
} from 'baileys';
import QRCode from 'qrcode';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelExec, buildReplyContext, splitContent, stripThinking } from './format.mjs';
import { parseAskReply } from './ask.mjs';
import { sameId, isGroup, numberOf, toJid, senderIsAdmin } from './jid.mjs';
import { MESSAGES } from './messages.mjs';
import { LiveMessage } from './stream.mjs';

// Reasoning-effort levels PI accepts for extended-thinking models (mirrors THINKING_LEVELS daemon-side).
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // larger inbound images are noted, not downloaded
const MAX_IMAGES = 4;                    // vision cap per message
const ASK_TTL_MS = 6 * 60_000;           // drop a pending ask/menu after this (> the core 5-min timeout)
const MENU_TTL_MS = 6 * 60_000;          // a numbered-menu number-reply is valid this long
const MAX_UPLOAD_IMAGES = 4;             // generated-image uploads per reply

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

function rolePrompt(policy) {
  const parts = [];
  if (policy.name) parts.push(`The user you are talking to has the "${policy.name}" role.`);
  if (policy.prompt) parts.push(policy.prompt);
  return parts.join('\n') || undefined;
}

export class WhatsAppAdapter {
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
      stream?.abandon(); // the stall-hint timer must not edit the dead progress bubble after the error reply
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
      // A single-question ask answers from one reply: a number (or a comma list on multiSelect) picks
      // and submits; anything else is a free-text answer when the question allows it. An unusable
      // reply (options-only question, no valid number) re-prompts instead of being swallowed.
      if (pend.questions.length === 1) {
        const q0 = pend.questions[0];
        const parsed = parseAskReply(t, q0);
        if (parsed?.kind === 'picks') {
          pend.selected[0] = parsed.labels;
          await this.submitAsk(id, m);
          return true;
        }
        if (parsed?.kind === 'other') {
          const settled = this.answerQuestion(id, [{ header: q0.header, selected: pend.selected[0] ?? [], other: parsed.text }]);
          this.pendingAsks.delete(id);
          if (settled) return true; // answer delivered — the model's reply is the acknowledgement, no ack line
          continue; // already timed out server-side → fall through and treat the message as a normal turn
        }
        const hint = q0.multiSelect ? this.msg.replyWithNumbers((q0.options ?? []).length) : this.msg.replyWithNumber((q0.options ?? []).length);
        await this.sendText(pend.jid, hint, m);
        return true;
      }
      // Multi-question asks collect a free-text answer for the first question that allows it, or `submit`.
      if (t && pend.questions[0]?.custom !== false) {
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

  /** Render a parked ask_user_question (brain `ask` event) as a numbered text prompt
   *  ("1. label — description"). On a single-question ask the user replies with a number (a comma list
   *  on multiSelect), or free text unless the question sets `custom: false`; multi-question asks collect
   *  a free-text answer or `submit`. Answers are delivered from handleTextReply. */
  async postAsk(chatJid, quoted, askerJid, id, questions) {
    const qs = questions.slice(0, 4);
    const blocks = qs.map((q) => {
      const opts = (q.options ?? []).slice(0, 25).map((op, oi) => `  ${oi + 1}. ${op.label}${op.description ? ` — ${op.description}` : ''}`);
      return `*${q.header}* — ${q.question}\n${opts.join('\n')}`;
    });
    const single = qs.length === 1;
    let hint = this.msg.submitHint;
    if (single) {
      const q0 = qs[0];
      const n = (q0.options ?? []).length;
      hint = q0.multiSelect ? this.msg.replyWithNumbers(n) : this.msg.replyWithNumber(n);
      if (q0.custom !== false) hint += ` ${this.msg.otherHint}`;
    }
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
