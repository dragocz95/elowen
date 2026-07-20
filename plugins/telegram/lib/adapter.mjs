// The Telegram adapter over grammY (long-polling): connection management, the inbound message pipeline,
// slash-command/inline-keyboard interactions, voice (STT/TTS) and outbound posting. Mirrors the Discord
// adapter feature-for-feature; the transport is grammY's Bot API instead of the Discord gateway/REST.
import { Bot, InputFile, GrammyError } from 'grammy';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseModelExec, buildReplyContext, stripForSpeech } from './format.mjs';
import { senderIds, senderIsAdmin, matchesId, displayNameOf } from './ids.mjs';
import { buildAskKeyboard } from './ask.mjs';
import { MESSAGES } from './messages.mjs';
import { LiveMessage, postWithImages } from './stream.mjs';
import { resolveDisplaySettings, updateDisplayOverrides } from './display.mjs';
import { CONTROL_COMMANDS, runControlCommand } from '../../_shared/chatCommands.mjs';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // default: larger images are noted, not downloaded (cfg: maxImageBytes)
const MAX_IMAGES = 4;                    // default vision cap per message (cfg: maxImages)
const ASK_TTL_MS = 6 * 60_000;           // default: drop a pending AskUserQuestion after this (cfg: askTimeoutMs; > the core 5-min timeout)
const MAX_UPLOAD_IMAGES = 4;             // default generated-image uploads per outgoing message (cfg: maxUploadImages)
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper's per-file limit — larger clips are just noted
const TTS_MAX_CHARS = 4000;              // cap the spoken text (OpenAI TTS input limit is 4096)
const MENU_TTL_MS = 6 * 60_000;          // a pending model picker's inline keyboard is valid this long
const PICKER_PAGE = 8;                   // inline-keyboard rows per page for the /model + /context pickers
const CONTEXT_MAX = 200;                 // upper bound of own conversations the /context picker pages over

/** Read a numeric config field, clamped to [min,max], falling back to `def` when unset/invalid. */
function cfgNum(cfg, key, def, min, max) {
  return Math.min(Math.max(Number(cfg?.[key]) || def, min), max);
}

/** A rolePolicy's extra per-role instructions, spliced into the turn's system prompt. */
function rolePrompt(policy) {
  const parts = [];
  if (policy.name) parts.push(`The user you are talking to has the "${policy.name}" role.`);
  if (policy.prompt) parts.push(policy.prompt);
  return parts.join('\n') || undefined;
}

/** Coerce a user-supplied chat target into what grammY expects: a numeric id (private/group/channel) or
 *  an `@channelusername` string. */
function chatTarget(v) {
  const s = String(v ?? '').trim();
  return /^-?\d+$/.test(s) ? Number(s) : s;
}

export class TelegramAdapter {
  name = 'telegram';
  constructor(cfg, logger, state, listModels, imageDirs = [], resolveProvider = () => null, answerQuestion = () => false, chatCommands = []) {
    this.cfg = cfg;
    this.log = logger;
    this.state = state;
    this.listModels = listModels;
    this.resolveProvider = resolveProvider; // central brain-provider key resolver (voice STT/TTS)
    this.imageDirs = imageDirs; // where the image-gen/image-edit plugins store their generated files
    this.answerQuestion = answerQuestion; // deliver a parked AskUserQuestion answer back to the turn
    this.chatCommands = chatCommands; // core names/descriptions — presentation/dispatch remains local
    this.handler = null;
    this.ctl = null; // host channel-control surface (stop/status/compact/restart), wired via control()
    this.bot = null;
    this.botId = null;
    this.botUsername = '';
    this.stopped = false;
    this.pendingAsks = new Map();    // token → { id, chatId, messageId, questions, askerId, selected, awaitingText, title, desc, createdAt }
    this.pendingPickers = new Map(); // chatId → { kind:'model', models, messageId, page, createdAt } | { kind:'context', sessions, messageId, page, createdAt }
    this.askSeq = 0;                 // short-token counter for ask callback_data (keeps it under 64 bytes)
    this.msg = MESSAGES[cfg.language === 'cs' ? 'cs' : 'en']; // service texts
  }

  listen(onMessage) { this.handler = onMessage; }
  /** Host wires the channel-control surface here (stop/status/compact/restart) right after listen(). */
  control(api) { this.ctl = api; }

  /** The chat conversation reference for commands: same identity onMessage reports (chat id folded with
   *  the /new generation), so a command targets the exact session a message would. */
  channelRef(chatId) { return { platform: 'telegram', channelId: `${chatId}#${this.state.get(String(chatId)).gen ?? 0}` }; }

  /** One inline-keyboard button per model over the FULL catalog (callback `m:<absoluteIndex>`), marking the
   *  chat's current pick — pagination handles the row cap, so no model is dropped. */
  modelRows(models, chatId) {
    const current = this.state.get(String(chatId)).model;
    return models.map((mo, i) => ({
      text: `${current && current.provider === mo.provider && current.model === mo.model ? '✅ ' : ''}${mo.model} · ${mo.providerLabel}`.slice(0, 64),
      callback_data: `m:${i}`,
    }));
  }

  /** One inline-keyboard button per bindable conversation (callback `c:<absoluteIndex>`) for the /context
   *  picker. */
  contextRows(sessions) {
    return sessions.map((s, i) => ({ text: (s.title || 'Untitled').slice(0, 64), callback_data: `c:${i}` }));
  }

  /** Page a flat list of single-button rows into an inline keyboard: the `page`-th window of ≤PICKER_PAGE
   *  buttons plus, when there is more than one page, a nav row (prev · indicator · next) whose arrows carry
   *  `${navPrefix}:<n>` and whose ends/indicator carry a `:noop`. Shared by /model and /context. */
  buildPagedKeyboard(rows, page, navPrefix) {
    const pages = Math.max(1, Math.ceil(rows.length / PICKER_PAGE));
    const p = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
    const kb = rows.slice(p * PICKER_PAGE, p * PICKER_PAGE + PICKER_PAGE).map((r) => [r]);
    if (pages > 1) {
      kb.push([
        { text: p > 0 ? '◀' : '·', callback_data: p > 0 ? `${navPrefix}:${p - 1}` : `${navPrefix}:noop` },
        { text: `${p + 1}/${pages}`, callback_data: `${navPrefix}:noop` },
        { text: p < pages - 1 ? '▶' : '·', callback_data: p < pages - 1 ? `${navPrefix}:${p + 1}` : `${navPrefix}:noop` },
      ]);
    }
    return kb;
  }

  /** Resolve the model that will drive the next turn. The catalog marks the daemon's real resolved
   *  default; catalog ordering is presentation-only and must not silently choose a different model. */
  modelForChannel(chatId, models) {
    const chosen = this.state.get(String(chatId)).model;
    return chosen
      ? models.find((m) => m.provider === chosen.provider && m.model === chosen.model)
      : (models.find((m) => m.default === true) ?? models[0]);
  }

  async connect() {
    this.stopped = false;
    // Testability seam: point grammY at a non-production Bot API server when `apiRoot` is configured
    // (the E2E suite injects a fake Bot API here). Pure passthrough — unset means grammY's own default
    // (https://api.telegram.org), so production behaviour is unchanged.
    const apiRoot = typeof this.cfg.apiRoot === 'string' && this.cfg.apiRoot.trim() ? this.cfg.apiRoot.trim() : '';
    this.bot = apiRoot ? new Bot(this.cfg.botToken, { client: { apiRoot } }) : new Bot(this.cfg.botToken);
    await this.bot.init(); // populate botInfo (id + username) before we publish commands / detect mentions
    this.botId = this.bot.botInfo?.id ?? null;
    this.botUsername = this.bot.botInfo?.username ?? '';
    await this.publishCommands().catch((e) => this.log.error(`command publish failed: ${e?.message ?? e}`));
    this.bot.on('message', (ctx) => void this.onMessage(ctx).catch((e) => this.log.error(`message handling failed: ${e?.message ?? e}`)));
    this.bot.on('callback_query:data', (ctx) => void this.onCallback(ctx).catch((e) => this.log.error(`callback failed: ${e?.message ?? e}`)));
    this.bot.catch((err) => this.log.error(`telegram error: ${err?.message ?? err}`));
    // Long-polling runs for the process lifetime — start it WITHOUT awaiting (connect() must return).
    void this.bot.start({ onStart: () => this.log.info(`telegram polling started as @${this.botUsername}`) })
      .catch((e) => { if (!this.stopped) this.log.error(`telegram polling stopped: ${e?.message ?? e}`); });
  }

  disconnect() {
    this.stopped = true;
    try { void this.bot?.stop(); } catch { /* already stopped */ }
  }

  /** Publish the bot's slash-command menu (setMyCommands). Names/help come from the shared command
   *  catalog; presentation/dispatch stays local. */
  async publishCommands() {
    const description = (name, fallback) => this.chatCommands.find((c) => c.name === name)?.description ?? fallback;
    const names = [
      ['model', 'Pick the AI model for this chat'],
      ['context', 'Continue this chat in one of your conversations'],
      ['reasoning', 'Set reasoning effort for this chat'],
      ...(this.chatCommands.some((c) => c.name === 'fast') ? [['fast', 'Toggle OpenAI OAuth priority processing']] : []),
      ['voice', 'Toggle spoken audio replies in this chat'],
      ['display', 'Configure live tools and answer delivery'],
      ['new', 'Start a fresh conversation in this chat'],
      ['stop', 'Stop the running agent in this chat'],
      ['status', 'Show the model, context and usage'],
      ['compact', 'Summarize the conversation to free up context'],
      ['restart', 'Restart the Elowen daemon (admin only)'],
      ['help', 'What can Elowen do here?'],
    ];
    const commands = names.map(([name, fallback]) => ({ command: name, description: String(description(name, fallback)).slice(0, 256) }));
    await this.bot.api.setMyCommands(commands);
  }

  // ── access resolution ──

  /** Whether the sender holds a rolePolicy flagged `admin: true` — the operator's own identity. Gates the
   *  shared per-chat pickers (/model, /reasoning) so a group's settings can't be changed by a member. */
  isAdmin(ids) {
    return senderIsAdmin(ids, this.cfg.rolePolicies);
  }

  /** Resolve a sender to an access descriptor (rolePolicy → projects/prompt + per-chat model). Returns
   *  `access: undefined` for an unmapped sender → the turn is dropped silently. */
  accessFor(ids, chatId) {
    const policies = Array.isArray(this.cfg.rolePolicies) ? this.cfg.rolePolicies : [];
    const match = policies.find((p) => p.roleId && ids.some((id) => matchesId(p.roleId, id)));
    if (!match) return { access: undefined };
    const st = this.state.get(String(chatId));
    const chosen = st.model;
    return {
      access: {
        // admin:true = the operator's admin identity — full project scope + the full plugin toolset
        // (trusted-chat). It does NOT grant the owner's Elowen* control-plane tools or API token: a shared
        // group is never the verified owner's own chat, whatever policy the sender matched.
        admin: match.admin === true,
        projectIds: (match.projectIds ?? []).map(Number),
        prompt: rolePrompt(match),
        model: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
        // Per-chat reasoning effort (set via /reasoning); empty = the model default.
        thinkingLevel: typeof st.thinkingLevel === 'string' ? st.thinkingLevel : undefined,
        fast: st.fast === true,
        // Per-role tool allowlist (undefined or ['*'] = everything the session would normally get).
        tools: Array.isArray(match.tools) && match.tools.length > 0 ? match.tools : undefined,
      },
    };
  }

  // ── inbound ──

  /** Whether a group message is addressed to the bot: an @mention of us (mention/text_mention entity) or
   *  a reply to one of our messages. Only consulted when respondWithoutMention is off. */
  isForMe(m) {
    if (!this.botId) return true; // not yet known → don't drop
    if (m.reply_to_message?.from?.id === this.botId) return true;
    const text = m.text ?? m.caption ?? '';
    const ents = m.entities ?? m.caption_entities ?? [];
    for (const e of ents) {
      if (e.type === 'mention' && this.botUsername) {
        const token = text.slice(e.offset, e.offset + e.length);
        if (token.toLowerCase() === `@${this.botUsername}`.toLowerCase()) return true;
      }
      if (e.type === 'text_mention' && e.user?.id === this.botId) return true;
    }
    return false;
  }

  /** Remove the bot's own @mention token from the text (case-insensitive). */
  stripMention(text) {
    let out = String(text ?? '');
    if (this.botUsername) out = out.replace(new RegExp(`@${this.botUsername}\\b`, 'gi'), '');
    return out.replace(/\s+/g, ' ').trim();
  }

  async onMessage(ctx) {
    const m = ctx.message;
    if (!this.handler || !m || m.from?.is_bot) return;
    const from = m.from;
    if (!from) return;
    const chat = m.chat;
    const chatId = chat.id;

    // Free-text answer to a parked AskUserQuestion ("✏️ Other"): if this chat has a pending ask awaiting
    // text from THIS sender, consume the message as that answer — not as a new brain turn.
    for (const [token, pend] of this.pendingAsks) {
      if (Date.now() - pend.createdAt > cfgNum(this.cfg, 'askTimeoutMs', ASK_TTL_MS, 30000, 1800000)) { this.pendingAsks.delete(token); continue; }
      if (!pend.awaitingText || pend.chatId !== chatId || pend.askerId !== from.id) continue;
      const other = String(m.text ?? '').trim();
      if (!other) continue;
      const q0 = pend.questions[0];
      const settled = this.answerQuestion(pend.id, [{ header: q0.header, selected: pend.selected[0] ?? [], other }]);
      this.pendingAsks.delete(token);
      if (!settled) break; // already timed out server-side → treat the message as a normal turn
      if (pend.messageId) void this.tgEdit(pend.chatId, pend.messageId, this.msg.askAnswered(`${q0.header}: ${other}`), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return; // this message was the answer
    }

    // Chat allowlist: when configured, the bot only responds in these chats. Empty/unset = everywhere.
    const allow = new Set(String(this.cfg.allowedChatIds ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    if (allow.size > 0 && !allow.has(String(chatId))) return;

    // Direct chats always respond; in groups respond only on @mention/reply-to-bot unless configured freely.
    const group = chat.type === 'group' || chat.type === 'supergroup';
    if (group && this.cfg.respondWithoutMention === false && !this.isForMe(m)) return;

    const ids = senderIds(from, chatId);
    const { access } = this.accessFor(ids, chatId);
    if (!access) return; // unmapped sender → stay silent (checked early: no download work for strangers)

    let text = this.stripMention(m.text ?? m.caption ?? '');

    // A slash command targets the bot's controls, not the brain.
    if (text.startsWith('/') && await this.handleCommand(chatId, from, ids, text)) return;

    const { images, audio, notes } = await this.collectMedia(m);
    if (notes.length) text = [text, ...notes].filter(Boolean).join('\n');
    // Voice messages / audio uploads: transcribe with Whisper when STT is enabled + keyed, else note.
    for (const clip of audio) {
      const transcript = (this.cfg.stt && this.voiceCreds())
        ? await this.transcribe(clip).catch((e) => { this.log.error(`STT failed: ${e?.message ?? e}`); return null; })
        : null;
      const line = transcript ? `[🎙️ Voice message: "${transcript}"]` : `[Attachment: ${clip.name} (${clip.type})]`;
      text = [text, line].filter(Boolean).join('\n');
    }
    if (!text && images.length) text = '[The user sent an image]'; // an image-only turn must not be empty
    if (!text) return;

    // Chat sessions are SHARED (one conversation per chat), so every message names its speaker — and a
    // Telegram reply carries the quoted original as context.
    const reply = m.reply_to_message;
    const replyCtx = reply ? buildReplyContext(displayNameOf(reply.from), reply.text ?? reply.caption ?? '') : '';
    const senderName = displayNameOf(from);
    const prefixed = `${replyCtx ? `${replyCtx}\n` : ''}[${senderName}] ${text}`;

    // The conversation key folds in the /new "generation" so a reset yields a clean session.
    const gen = this.state.get(String(chatId)).gen ?? 0;
    const convoKey = `${chatId}#${gen}`;

    const reactions = this.cfg.reactions !== false;
    const display = resolveDisplaySettings(this.cfg, this.state.get(String(chatId)));
    const observesLiveEvents = display.toolActivity !== 'off' || display.answerMode === 'live' || this.cfg.showReasoning === true;
    const stream = observesLiveEvents ? new LiveMessage(this, chatId, m.message_id, from.id, display) : null;
    // Even with live streaming OFF, AskUserQuestion must still render its choice message — otherwise the
    // parked turn hangs until the timeout. Route events through the stream when present, else handle only `ask`.
    const onEvent = stream
      ? (e) => stream.onEvent(e)
      : (e) => { if (e.type === 'ask' && Array.isArray(e.questions)) void this.postAsk(chatId, m.message_id, from.id, e.id, e.questions).catch(() => {}); };
    const typing = setInterval(() => void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {}), 5000);
    void this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
    if (reactions) void this.react(chatId, m.message_id, '👀').catch(() => {}); // status: seen

    // Image turns steer to the configured vision model — the chat's normal model may be text-only.
    const vision = images.length ? parseModelExec(this.cfg.visionModel) : null;
    let turnAccess = access;
    if (vision) {
      const models = await this.listModels().catch(() => []);
      const visionOption = models.find((mo) => mo.model === vision.model && (!vision.provider || mo.provider === vision.provider));
      // Fast belongs to the normal chat profile. A non-OAuth vision hop clears it only for this temporary
      // request; persisted chat state stays untouched and resumes on the normal model.
      turnAccess = { ...access, model: vision, ...(!visionOption?.fastAvailable ? { fast: false } : {}) };
    }

    try {
      const replyText = await this.handler(
        {
          platform: 'telegram', userId: String(from.id), userName: senderName, roleIds: ids, channelId: convoKey, access: turnAccess,
          channelName: group ? (chat.title || undefined) : undefined,
          images: images.length ? images : undefined,
        },
        prefixed,
        onEvent,
      );
      clearInterval(typing);
      if (stream) await stream.finalize(replyText);
      else if (replyText) await this.reply(chatId, replyText, m.message_id);
      // Spoken reply (per-chat /voice, default cfg.tts): attach a voice note. Best-effort — a TTS failure
      // never blocks the text reply that already went out.
      if (replyText && this.voiceEnabled(String(chatId)) && this.voiceCreds()) {
        await this.speakReply(chatId, replyText, m.message_id).catch((e) => this.log.error(`TTS failed: ${e?.message ?? e}`));
      }
      if (reactions) void this.react(chatId, m.message_id, '👍').catch(() => {});
    } catch (e) {
      clearInterval(typing);
      if (stream) await stream.fail(e?.message ?? e); // settle live tools before the error reply lands below them
      if (reactions) void this.react(chatId, m.message_id, '👎').catch(() => {});
      await this.reply(chatId, `⚠️ ${e?.message ?? e}`, m.message_id).catch(() => {});
    }
  }

  /** Split a message's media into vision-ready images (downloaded + base64, capped) and textual notes for
   *  everything else. Photos and image documents feed vision; voice/audio are transcribed upstream. */
  async collectMedia(m) {
    const images = [];
    const audio = [];
    const notes = [];
    const maxImageBytes = cfgNum(this.cfg, 'maxImageBytes', MAX_IMAGE_BYTES, 1048576, 20971520);
    const maxImages = cfgNum(this.cfg, 'maxImages', MAX_IMAGES, 1, 10);
    const addImage = async (fileId, size, mime) => {
      if (images.length >= maxImages) return;
      if (size && size > maxImageBytes) { notes.push('[Attachment: image (too large to read)]'); return; }
      try {
        const buf = await this.downloadFile(fileId);
        images.push({ data: buf.toString('base64'), mimeType: mime || 'image/jpeg' });
      } catch (e) { notes.push('[Attachment: image (download failed)]'); this.log.error(`image download failed: ${e?.message ?? e}`); }
    };
    if (Array.isArray(m.photo) && m.photo.length) {
      const largest = m.photo[m.photo.length - 1]; // PhotoSize array is ascending → last is the biggest
      await addImage(largest.file_id, largest.file_size, 'image/jpeg');
    }
    if (m.document) {
      const d = m.document;
      if (String(d.mime_type ?? '').startsWith('image/')) await addImage(d.file_id, d.file_size, d.mime_type);
      else notes.push(`[Attachment: ${d.file_name ?? 'document'} (${d.mime_type ?? 'unknown'})]`);
    }
    if (m.voice) audio.push({ fileId: m.voice.file_id, name: 'voice.ogg', type: m.voice.mime_type || 'audio/ogg', size: m.voice.file_size ?? 0 });
    if (m.audio) audio.push({ fileId: m.audio.file_id, name: m.audio.file_name || 'audio.mp3', type: m.audio.mime_type || 'audio/mpeg', size: m.audio.file_size ?? 0 });
    if (m.video && !m.caption) notes.push('[Attachment: video]');
    return { images, audio, notes };
  }

  /** Download a Telegram file by id: getFile → the CDN file path → the bot-file endpoint. Returns a Buffer. */
  async downloadFile(fileId) {
    const f = await this.bot.api.getFile(fileId);
    if (!f?.file_path) throw new Error('no file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${this.cfg.botToken}/${f.file_path}`);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ── AskUserQuestion ──

  /** Render a parked AskUserQuestion (from the brain's `ask` event) as a prompt message plus an inline
   *  keyboard — option buttons per question, a Submit button for multi-select/multi-question asks, and a
   *  free-text "Other" button on single-question asks. Registers a pending entry the callback/text
   *  handlers resolve. Keyed by a SHORT token so the callback_data stays under Telegram's 64-byte limit. */
  async postAsk(chatId, replyToId, askerId, id, questions) {
    const cs = this.cfg.language === 'cs';
    const qs = questions.slice(0, 4);
    const token = (++this.askSeq).toString(36);
    const title = `❓ ${this.cfg.agentName || 'Elowen'} ${cs ? 'potřebuje tvůj vstup' : 'needs your input'}`;
    const desc = qs.map((q) => `${q.header} — ${q.question}`).join('\n\n');
    const extra = {
      reply_markup: { inline_keyboard: buildAskKeyboard(token, qs, { cs }) },
      ...(replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {}),
    };
    const messageId = await this.tgSend(chatId, `${title}\n\n${desc}`, extra);
    this.pendingAsks.set(token, { id, chatId, messageId, questions: qs, askerId, selected: {}, awaitingText: false, title, desc, createdAt: Date.now() });
  }

  /** Deliver every collected pick of a pending ask to the parked turn and close out the message. */
  async settleAsk(ctx, token, pend) {
    const answers = pend.questions.map((q, qi) => ({ header: q.header, selected: pend.selected[qi] ?? [] }));
    const settled = this.answerQuestion(pend.id, answers);
    this.pendingAsks.delete(token);
    await ctx.answerCallbackQuery().catch(() => {});
    if (!settled) { await this.tgEdit(pend.chatId, pend.messageId, this.msg.askExpired, { reply_markup: { inline_keyboard: [] } }).catch(() => {}); return; }
    const summary = answers.map((a) => `${a.header}: ${a.selected.join(', ') || '—'}`).join('\n');
    await this.tgEdit(pend.chatId, pend.messageId, this.msg.askAnswered(summary), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }

  /** Resolve an `a:*` callback: an option button records that question's pick — and answers instantly on a
   *  single-question single-select ask; a multi-select toggles; Submit delivers all answers; Other flips to
   *  free-text capture (the next chat message answers). */
  async onAskInteraction(ctx) {
    const cs = this.cfg.language === 'cs';
    const [, token, part, sub] = String(ctx.callbackQuery.data).split(':');
    const pend = this.pendingAsks.get(token);
    if (!pend) { await ctx.answerCallbackQuery().catch(() => {}); return; } // expired → drop
    const clickerId = ctx.callbackQuery.from?.id;
    const ids = senderIds(ctx.callbackQuery.from, pend.chatId);
    // Only the person the question was posed to (or the operator) may answer it.
    if (clickerId && clickerId !== pend.askerId && !this.isAdmin(ids)) {
      await ctx.answerCallbackQuery({ text: this.msg.askForSomeoneElse, show_alert: true }).catch(() => {});
      return;
    }
    if (part === 'submit') return this.settleAsk(ctx, token, pend);
    if (part === 'other') {
      pend.awaitingText = true;
      await ctx.answerCallbackQuery().catch(() => {});
      await this.tgEdit(pend.chatId, pend.messageId, `${pend.title}\n\n${pend.desc}\n\n${this.msg.askTypeAnswer}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    const qi = Number(part);
    const q = pend.questions[qi];
    if (!q || sub === undefined) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    const label = q.options[Number(sub)]?.label;
    if (label) {
      if (q.multiSelect) {
        const cur = new Set(pend.selected[qi] ?? []);
        if (cur.has(label)) cur.delete(label); else cur.add(label);
        pend.selected[qi] = [...cur];
      } else {
        pend.selected[qi] = [label];
      }
    }
    // A single-question single-select ask answers right away; anything else re-renders so the ✅ shows the
    // pick and Submit delivers later.
    if (pend.questions.length === 1 && q.multiSelect !== true) return this.settleAsk(ctx, token, pend);
    await ctx.answerCallbackQuery().catch(() => {});
    await this.tgEdit(pend.chatId, pend.messageId, `${pend.title}\n\n${pend.desc}`, { reply_markup: { inline_keyboard: buildAskKeyboard(token, pend.questions, { cs, selected: pend.selected }) } }).catch(() => {});
  }

  // ── commands ──

  /** Handle a `/command`. Returns true when the text was a (recognized) command. */
  async handleCommand(chatId, from, ids, text) {
    const [cmdRaw, ...argParts] = text.slice(1).trim().split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase(); // strip a trailing @botusername (group form)
    const arg = argParts.join(' ').trim().toLowerCase();
    const admin = () => this.isAdmin(ids);
    // Control commands (new/fast/stop/status/compact/restart) share one transport-agnostic core; only the
    // pickers below stay local because their inline-keyboard UI is Telegram-specific.
    if (CONTROL_COMMANDS.has(cmd)) {
      return runControlCommand(cmd, {
        msg: this.msg, reply: (t) => this.tgSend(chatId, t), isAdmin: admin, arg,
        state: this.state, stateId: String(chatId), ctl: this.ctl, ref: this.channelRef(chatId),
        activeModel: async () => this.modelForChannel(chatId, await this.listModels().catch(() => [])),
        fastEnabled: this.chatCommands.some((c) => c.name === 'fast'),
      });
    }
    switch (cmd) {
      case 'help':
        await this.tgSend(chatId, this.msg.help(this.cfg.agentName || 'Elowen'));
        return true;
      case 'model': {
        if (!admin()) { await this.tgSend(chatId, this.msg.modelForbidden); return true; }
        const models = await this.listModels().catch(() => []);
        if (!models.length) { await this.tgSend(chatId, this.msg.noModels); return true; }
        // The FULL catalog is paged in-memory (nav callbacks below), so a model past the first page is
        // reachable instead of being silently truncated.
        const keyboard = this.buildPagedKeyboard(this.modelRows(models, chatId), 0, 'm_page');
        const messageId = await this.tgSend(chatId, this.msg.pickModel, { reply_markup: { inline_keyboard: keyboard } });
        this.pendingPickers.set(String(chatId), { kind: 'model', models, messageId, page: 0, createdAt: Date.now() });
        return true;
      }
      case 'context': {
        // Operator-gated like /model; ownership is enforced server-side (only the invoking sender's OWN
        // conversations are offered, and binding re-checks). Binding exposes the chosen history to this chat.
        if (!admin()) { await this.tgSend(chatId, this.msg.controlForbidden); return true; }
        const listing = this.ctl?.listContext?.(this.channelRef(chatId), String(from.id), { offset: 0, limit: CONTEXT_MAX }) ?? null;
        if (!listing || !listing.items.length) { await this.tgSend(chatId, this.msg.noContextSessions); return true; }
        const sessions = listing.items;
        const keyboard = this.buildPagedKeyboard(this.contextRows(sessions), 0, 'c_page');
        const messageId = await this.tgSend(chatId, this.msg.pickContext, { reply_markup: { inline_keyboard: keyboard } });
        this.pendingPickers.set(String(chatId), { kind: 'context', sessions, messageId, page: 0, createdAt: Date.now() });
        return true;
      }
      case 'reasoning': {
        if (!admin()) { await this.tgSend(chatId, this.msg.modelForbidden); return true; }
        const models = await this.listModels().catch(() => []);
        if (!models.length) { await this.tgSend(chatId, this.msg.noModels); return true; }
        const active = this.modelForChannel(chatId, models);
        const levels = Array.isArray(active?.reasoningLevels) ? active.reasoningLevels : [];
        if (!levels.length) { await this.tgSend(chatId, this.msg.reasoningUnavailable); return true; }
        const current = this.state.get(String(chatId)).thinkingLevel ?? '';
        const keyboard = [
          [{ text: `${current === '' ? '✅ ' : ''}${this.msg.reasoningDefault}`, callback_data: 'r:default' }],
          ...levels.map((level) => [{ text: `${current === level ? '✅ ' : ''}${active.reasoningLabels?.[level] ?? level}`.slice(0, 64), callback_data: `r:${level}`.slice(0, 64) }]),
        ];
        await this.tgSend(chatId, this.msg.pickThinking, { reply_markup: { inline_keyboard: keyboard } });
        return true;
      }
      case 'voice': {
        if (!admin()) { await this.tgSend(chatId, this.msg.modelForbidden); return true; }
        const next = arg === 'on' ? true : arg === 'off' ? false : !this.voiceEnabled(String(chatId));
        this.state.patch(String(chatId), { voice: next });
        const note = next && !this.voiceCreds() ? `\n${this.msg.voiceNeedsKey}` : '';
        await this.tgSend(chatId, `${this.msg.voiceSet(next)}${note}`);
        return true;
      }
      case 'display': {
        if (!admin()) { await this.tgSend(chatId, this.msg.controlForbidden); return true; }
        const resolved = resolveDisplaySettings(this.cfg, this.state.get(String(chatId)));
        await this.tgSend(chatId, this.msg.displaySet(resolved), { reply_markup: { inline_keyboard: this.displayKeyboard(resolved) } });
        return true;
      }
      default:
        return false; // unknown /word → treat as a normal message
    }
  }

  /** Inline-keyboard rows for `/display` — one row per axis, each option a `d:<axis>:<value>` button
   *  (the resolved value marked ✅; `default` clears the per-chat override). */
  displayKeyboard(resolved) {
    const row = (axis, cur, opts) => opts.map(([v, label]) => ({ text: `${cur === v ? '✅ ' : ''}${label}`, callback_data: `d:${axis}:${v}` }));
    return [
      row('toolActivity', resolved.toolActivity, [['off', 'off'], ['status', 'status'], ['live', 'live'], ['default', 'reset']]),
      row('answerMode', resolved.answerMode, [['final', 'final'], ['live', 'live'], ['default', 'reset']]),
      row('toolOutput', resolved.toolOutput, [['hidden', 'hidden'], ['summary', 'summary'], ['tail', 'tail'], ['default', 'reset']]),
      row('toolMessageMode', resolved.toolMessageMode, [['single', 'single'], ['per_tool', 'per-tool'], ['default', 'reset']]),
    ];
  }

  /** Route an inline-keyboard callback: ask interactions (`a:*`), model/reasoning/display pickers. All the
   *  picker branches are operator-gated (the setting is shared by everyone in the chat). */
  async onCallback(ctx) {
    const data = ctx.callbackQuery?.data ?? '';
    if (data.startsWith('a:')) return this.onAskInteraction(ctx);
    const chatId = ctx.callbackQuery.message?.chat?.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (chatId == null || messageId == null) { await ctx.answerCallbackQuery().catch(() => {}); return; }
    const ids = senderIds(ctx.callbackQuery.from, chatId);

    if (data.startsWith('m:')) {
      if (!this.isAdmin(ids)) { await ctx.answerCallbackQuery({ text: this.msg.modelForbidden, show_alert: true }).catch(() => {}); return; }
      const picker = this.pendingPickers.get(String(chatId));
      const stale = !picker || picker.kind !== 'model' || Date.now() - picker.createdAt > MENU_TTL_MS;
      const mo = stale ? null : picker.models[Number(data.slice(2))];
      if (mo) {
        const models = await this.listModels().catch(() => []);
        const selected = models.find((e) => e.provider === mo.provider && e.model === mo.model);
        // Fast is a provider capability, not a portable chat preference — clear it when leaving OAuth.
        this.state.patch(String(chatId), { model: { provider: mo.provider, model: mo.model }, ...(!selected?.fastAvailable ? { fast: false } : {}) });
      }
      this.pendingPickers.delete(String(chatId));
      await ctx.answerCallbackQuery().catch(() => {});
      await this.tgEdit(chatId, messageId, mo ? this.msg.modelSet(mo.model) : this.msg.noModels, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (data.startsWith('r:')) {
      if (!this.isAdmin(ids)) { await ctx.answerCallbackQuery({ text: this.msg.modelForbidden, show_alert: true }).catch(() => {}); return; }
      const value = data.slice(2);
      const models = await this.listModels().catch(() => []);
      const active = this.modelForChannel(chatId, models);
      const levels = Array.isArray(active?.reasoningLevels) ? active.reasoningLevels : [];
      await ctx.answerCallbackQuery().catch(() => {});
      if (!levels.length || (value !== 'default' && !levels.includes(value))) {
        await this.tgEdit(chatId, messageId, this.msg.reasoningUnavailable, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        return;
      }
      const level = value === 'default' ? '' : value;
      this.state.patch(String(chatId), { thinkingLevel: level });
      const displayLevel = level ? String(active.reasoningLabels?.[level] ?? level) : this.msg.reasoningDefaultValue;
      await this.tgEdit(chatId, messageId, this.msg.thinkingSet(displayLevel), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return;
    }
    if (data.startsWith('d:')) {
      if (!this.isAdmin(ids)) { await ctx.answerCallbackQuery({ text: this.msg.controlForbidden, show_alert: true }).catch(() => {}); return; }
      const [, axis, value] = data.split(':');
      const st = this.state.get(String(chatId));
      this.state.patch(String(chatId), { display: updateDisplayOverrides(st.display, { [axis]: value }) });
      const resolved = resolveDisplaySettings(this.cfg, this.state.get(String(chatId)));
      await ctx.answerCallbackQuery().catch(() => {});
      await this.tgEdit(chatId, messageId, this.msg.displaySet(resolved), { reply_markup: { inline_keyboard: this.displayKeyboard(resolved) } }).catch(() => {});
      return;
    }
    // Paged-picker nav (`m_page:<n>` / `c_page:<n>`): page the list already cached in pendingPickers and
    // swap the inline keyboard in place — no re-fetch. Operator-gated like the pickers themselves.
    if (data.startsWith('m_page:') || data.startsWith('c_page:')) {
      if (!this.isAdmin(ids)) { await ctx.answerCallbackQuery({ text: this.msg.modelForbidden, show_alert: true }).catch(() => {}); return; }
      await ctx.answerCallbackQuery().catch(() => {});
      const kind = data.startsWith('m_page:') ? 'model' : 'context';
      const navPrefix = kind === 'model' ? 'm_page' : 'c_page';
      const rest = data.slice(navPrefix.length + 1);
      if (rest === 'noop') return;
      const page = Number(rest);
      const picker = this.pendingPickers.get(String(chatId));
      if (!Number.isInteger(page) || !picker || picker.kind !== kind || Date.now() - picker.createdAt > MENU_TTL_MS) return;
      picker.page = page;
      const rows = kind === 'model' ? this.modelRows(picker.models, chatId) : this.contextRows(picker.sessions);
      await this.bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: this.buildPagedKeyboard(rows, page, navPrefix) } }).catch(() => {});
      return;
    }
    if (data.startsWith('c:')) {
      if (!this.isAdmin(ids)) { await ctx.answerCallbackQuery({ text: this.msg.controlForbidden, show_alert: true }).catch(() => {}); return; }
      const picker = this.pendingPickers.get(String(chatId));
      const stale = !picker || picker.kind !== 'context' || Date.now() - picker.createdAt > MENU_TTL_MS;
      const session = stale ? null : picker.sessions[Number(data.slice(2))];
      await ctx.answerCallbackQuery().catch(() => {});
      this.pendingPickers.delete(String(chatId));
      if (!session) { await this.tgEdit(chatId, messageId, this.msg.noContextSessions, { reply_markup: { inline_keyboard: [] } }).catch(() => {}); return; }
      if (!this.ctl?.bindContext) { await this.tgEdit(chatId, messageId, this.msg.noSession, { reply_markup: { inline_keyboard: [] } }).catch(() => {}); return; }
      // The MOVE is dispatched through the host control surface; ownership is re-verified server-side.
      try {
        const { title } = await this.ctl.bindContext(this.channelRef(chatId), String(ctx.callbackQuery.from?.id ?? ''), session.id);
        await this.tgEdit(chatId, messageId, this.msg.contextBound(title), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      } catch (e) {
        await this.tgEdit(chatId, messageId, this.msg.contextError(e?.message ?? e), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
  }

  // ── outbound helpers ──

  /** Post a final text reply (image links become photo uploads) — the non-streamed path. */
  async reply(chatId, text, replyToId) {
    await postWithImages(this, chatId, text, replyToId);
  }

  /** Send one text message. Returns the new message_id (null on failure). Retries once on a 429 flood
   *  wait; a "message is not modified" never applies to a fresh send. */
  async tgSend(chatId, text, extra = {}, attempt = 0) {
    try {
      const m = await this.bot.api.sendMessage(chatId, text, extra);
      return m?.message_id ?? null;
    } catch (e) {
      if (attempt < 3 && await this.floodWait(e)) return this.tgSend(chatId, text, extra, attempt + 1);
      this.log.error(`sendMessage failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Edit a message's text. Returns true on success (or when the content was already current — Telegram
   *  answers "message is not modified", which is a benign no-op here). Retries once on a 429 flood wait. */
  async tgEdit(chatId, messageId, text, extra = {}, attempt = 0) {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text, extra);
      return true;
    } catch (e) {
      if (e instanceof GrammyError && /message is not modified/i.test(e.description ?? '')) return true;
      if (attempt < 3 && await this.floodWait(e)) return this.tgEdit(chatId, messageId, text, extra, attempt + 1);
      return false;
    }
  }

  /** Delete a message — best-effort (a message too old to delete, or already gone, is fine). */
  async tgDelete(chatId, messageId) {
    try { await this.bot.api.deleteMessage(chatId, messageId); } catch { /* already gone / too old */ }
  }

  /** When the error is a Telegram 429 flood wait, sleep for its retry_after and signal a retry. */
  async floodWait(e) {
    if (e instanceof GrammyError && e.error_code === 429) {
      const wait = (e.parameters?.retry_after ?? 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return true;
    }
    return false;
  }

  /** React to a message with an emoji (fail-soft: Telegram allows only a limited reaction set, so an
   *  unsupported emoji simply throws and the caller's .catch swallows it). */
  react(chatId, messageId, emoji) {
    return this.bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]);
  }

  /** Send generated images as photo messages (the first optionally anchored to the trigger). */
  async sendPhotos(chatId, files, extra = {}) {
    for (let i = 0; i < files.length; i++) {
      try { await this.bot.api.sendPhoto(chatId, new InputFile(files[i].data, files[i].name), i === 0 ? extra : {}); }
      catch (e) { this.log.error(`sendPhoto failed: ${e?.message ?? e}`); }
    }
  }

  /** Load up to the configured cap (default MAX_UPLOAD_IMAGES) of generated images by validated name from
   *  the image plugins' data dirs. A missing/unreadable file is skipped silently. */
  resolveImageFiles(names) {
    const files = [];
    const cap = cfgNum(this.cfg, 'maxUploadImages', MAX_UPLOAD_IMAGES, 1, 10);
    for (const name of names.slice(0, cap)) {
      for (const dir of this.imageDirs) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        try { files.push({ name, data: readFileSync(p) }); } catch { /* unreadable → skip */ }
        break;
      }
    }
    return files;
  }

  // ── voice ──

  /** Resolve the voice provider's credentials (central brain provider chosen in config) → { apiKey,
   *  baseUrl }, or null when unset/keyless. baseUrl carries the audio endpoints (e.g. …/v1). */
  voiceCreds() {
    const id = typeof this.cfg.voiceProvider === 'string' ? this.cfg.voiceProvider.trim() : '';
    if (!id) return null;
    const p = this.resolveProvider(id);
    if (!p?.apiKey || !p.baseUrl) return null;
    return { apiKey: p.apiKey, baseUrl: String(p.baseUrl).replace(/\/+$/, '') };
  }

  /** Transcribe one audio clip via Whisper — download the Telegram file, then multipart it to the
   *  provider's /audio/transcriptions. Returns the trimmed text, or null when empty/oversized/keyless. */
  async transcribe(clip) {
    const creds = this.voiceCreds();
    if (!creds) return null;
    if ((clip.size ?? 0) > MAX_AUDIO_BYTES) throw new Error('audio over Whisper size limit');
    const buf = await this.downloadFile(clip.fileId);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: clip.type || 'audio/ogg' }), clip.name || 'audio.ogg');
    form.append('model', String(this.cfg.sttModel || 'whisper-1'));
    const res = await fetch(`${creds.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: { authorization: `Bearer ${creds.apiKey}` }, body: form,
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
    const j = await res.json().catch(() => ({}));
    const t = typeof j?.text === 'string' ? j.text.trim() : '';
    return t || null;
  }

  /** Whether spoken replies are on for a chat: the per-chat /voice toggle wins, else cfg.tts. */
  voiceEnabled(chatId) {
    const s = this.state.get(String(chatId)).voice;
    return typeof s === 'boolean' ? s : this.cfg.tts === true;
  }

  /** Synthesize the reply text (markdown-stripped) with the provider's TTS and attach it as a voice note
   *  (OGG/Opus, which Telegram renders as a real voice message). */
  async speakReply(chatId, text, replyToId) {
    const creds = this.voiceCreds();
    if (!creds) return;
    const input = stripForSpeech(text).slice(0, TTS_MAX_CHARS);
    if (!input) return;
    const res = await fetch(`${creds.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${creds.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: String(this.cfg.ttsModel || 'gpt-4o-mini-tts'), voice: String(this.cfg.ttsVoice || 'alloy'), input, response_format: 'opus' }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await this.bot.api.sendVoice(chatId, new InputFile(buf, 'reply.ogg'), replyToId ? { reply_parameters: { message_id: replyToId, allow_sending_without_reply: true } } : {});
  }

  // ── proactive + tools ──

  /** Host-initiated push (cron/tick echoes) → the configured notification chat. No-op without one. */
  async notify(text, chatId) {
    const target = (typeof chatId === 'string' && chatId.trim())
      || (typeof this.cfg.notifyChatId === 'string' ? this.cfg.notifyChatId.trim() : '');
    if (!target || !this.bot) return;
    await this.reply(chatTarget(target), text);
  }

  /** The live bot, or a thrown error when not yet connected — used by the Telegram* tools. */
  requireBot() {
    if (!this.bot) throw new Error('Telegram is not connected yet — check the plugin config (botToken).');
    return this.bot;
  }

  /** Call any raw Bot API method by name (used by the owner-only TelegramApi tool). */
  async callApi(method, params) {
    const bot = this.requireBot();
    if (typeof bot.api.raw[method] !== 'function') throw new Error(`unknown Bot API method: ${method}`);
    return bot.api.raw[method](params ?? {});
  }
}
