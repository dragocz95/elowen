// The Microsoft Teams adapter: inbound Bot Framework activities from the daemon's /hooks webhook,
// outbound replies through the Bot Connector REST API. The webhook handler answers 200 immediately and
// runs the brain turn async — the connector delivers the reply, never the HTTP response (Microsoft's
// callback deadline is far shorter than a long agent turn). On top of plain chat: a stateful live tool
// trace (edited in place), AskUserQuestion as Adaptive Cards, slash commands with card pickers, per-chat
// model/reasoning/display settings and image round-trips.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorClient } from './connector.mjs';
import { makeTokenVerifier } from './auth.mjs';
import { matchesId, senderIds, senderIsAdmin, displayNameOf } from './ids.mjs';
import { parseModelExec, splitContent } from './format.mjs';
import { MESSAGES } from './messages.mjs';
import { LiveMessage, postWithImages } from './stream.mjs';
import { buildAskCard, buildPickerCard, settledCard } from './cards.mjs';
import { buildAppPackage } from './appPackage.mjs';
import { CONTROL_COMMANDS, runControlCommand } from '../../_shared/chatCommands.mjs';
import { resolveDisplaySettings, updateDisplayOverrides } from '../../_shared/display.mjs';

/** The `/display` axes and their values — mirrors the resolution sets in _shared/display.mjs. */
const DISPLAY_AXES = {
  toolActivity: ['off', 'status', 'live'],
  answerMode: ['final', 'live'],
  toolOutput: ['hidden', 'summary', 'tail'],
  toolMessageMode: ['single', 'per_tool'],
};

const MAX_IMAGE_BYTES = 5242880;
const MAX_IMAGES = 4;
const MAX_UPLOAD_IMAGES = 4;
const ASK_TTL_MS = 360000;
const TYPING_INTERVAL_MS = 8000;
const CONTEXT_MAX = 40;

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

export class MsTeamsAdapter {
  name = 'msteams';
  constructor(cfg, logger, state, listModels, imageDirs = [], resolveProvider = () => null, answerQuestion = () => false, chatCommands = () => []) {
    this.cfg = cfg;
    this.log = logger;
    this.state = state;
    this.listModels = listModels;
    this.resolveProvider = resolveProvider;
    this.imageDirs = imageDirs;
    this.answerQuestion = answerQuestion;
    this.chatCommands = chatCommands;
    this.handler = null;
    this.ctl = null;
    this.stopped = false;
    this.connector = new ConnectorClient(cfg, logger);
    this.verifyToken = makeTokenVerifier(cfg, logger);
    this.upnCache = new Map();       // from.id → UPN/email resolved via the conversation roster
    this.notifyConversations = new Map(); // notify user target → opened personal conversation id
    this.pendingAsks = new Map();    // token → { id, conversationId, activityId, questions, askerId, selected, createdAt }
    this.pendingPickers = new Map(); // conversationId → { kind, options, activityId, page, senderId, createdAt, sessions? }
    this.askSeq = 0;
    this.msg = MESSAGES[cfg.language] ?? MESSAGES.en; // service texts
  }

  listen(onMessage) { this.handler = onMessage; }
  control(api) { this.ctl = api; }

  /** The chat conversation reference for commands: the same identity onMessage reports (conversation id
   *  folded with the /new generation), so a command targets the exact session a message would. */
  channelRef(conversationId) {
    const gen = this.state.get(String(conversationId)).gen ?? 0;
    return { platform: 'msteams', channelId: `${conversationId}#${gen}` };
  }

  /** Validate the credentials eagerly so a typo'd secret surfaces at enable time, not on the first
   *  message. A failure logs and keeps the adapter up — inbound validation still guards the webhook. */
  async connect() {
    this.stopped = false;
    try {
      await this.connector.token();
      this.log.info(`msteams connected (app ${this.cfg.appId})`);
    } catch (e) {
      this.log.warn(`msteams credential check failed: ${e?.message ?? e}`);
    }
  }

  disconnect() { this.stopped = true; }

  // ── inbound (the /hooks/msteams/messages handler) ──

  async handleWebhook(req) {
    if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
    let activity;
    try { activity = await req.json(); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
    if (!(await this.verifyToken(req.headers.authorization, activity))) return { status: 401, body: { error: 'unauthorized' } };
    if (this.stopped || !this.handler) return { status: 200, body: {} };

    if (activity?.type === 'message') {
      // Answer the callback NOW; everything below runs async and replies through the connector.
      const work = activity.value && typeof activity.value === 'object'
        ? this.onCardAction(activity)   // an Adaptive Card Action.Submit round-trip, not a user message
        : this.onActivity(activity);
      void work.catch((e) => this.log.error(`msteams turn failed: ${e?.message ?? e}`));
      return { status: 200, body: {} };
    }
    if (activity?.type === 'conversationUpdate') {
      this.rememberConversation(activity);
      return { status: 200, body: {} };
    }
    return { status: 200, body: {} };
  }

  /** Persist where we can reach this conversation later (replies after the callback died, proactive
   *  notify): the serviceUrl travels on every inbound activity and may rotate between regions. Writes
   *  only on change — this runs per message and the ref is almost always already current. */
  rememberConversation(activity) {
    const conv = activity?.conversation;
    if (!conv?.id || typeof activity?.serviceUrl !== 'string') return;
    const ref = {
      serviceUrl: activity.serviceUrl,
      conversationType: conv.conversationType,
      tenantId: conv.tenantId,
      botId: activity.recipient?.id,
    };
    const prior = this.state.get(String(conv.id)).ref;
    if (JSON.stringify(prior) !== JSON.stringify(ref)) this.state.patch(String(conv.id), { ref });
    if (this.state.get('_meta').serviceUrl !== activity.serviceUrl) this.state.patch('_meta', { serviceUrl: activity.serviceUrl });
  }

  /** The connector route for a conversation: its stored ref, else the last serviceUrl seen anywhere. */
  serviceUrlFor(conversationId) {
    return this.state.get(String(conversationId)).ref?.serviceUrl ?? this.state.get('_meta').serviceUrl;
  }

  /** Whether a shared-chat message is addressed to the bot: Teams marks the bot's own mention with an
   *  entity whose `mentioned.id` equals our recipient id. */
  isForMe(activity) {
    const botId = activity.recipient?.id;
    if (!botId) return false;
    for (const e of activity.entities ?? []) {
      if (e?.type === 'mention' && e.mentioned?.id === botId) return true;
    }
    return false;
  }

  /** Remove `<at>…</at>` mention spans (the bot's own mention text) and collapse whitespace. */
  stripMention(text) {
    return String(text ?? '').replace(/<at>[^<]*<\/at>/gi, '').replace(/\s+/g, ' ').trim();
  }

  isAdmin(ids) {
    return senderIsAdmin(ids, this.cfg.rolePolicies);
  }

  /** Resolve a sender to an access descriptor (rolePolicy → projects/prompt + per-chat model). Returns
   *  `access: undefined` for an unmapped sender → the turn is dropped silently. */
  accessFor(ids, conversationId) {
    const policies = Array.isArray(this.cfg.rolePolicies) ? this.cfg.rolePolicies : [];
    const match = policies.find((p) => p.roleId && ids.some((id) => matchesId(p.roleId, id)));
    if (!match) return { access: undefined };
    const st = this.state.get(String(conversationId));
    const chosen = st.model;
    return {
      access: {
        // admin:true = the operator's admin identity — full project scope + the full plugin toolset
        // (trusted-chat). It does NOT grant the owner's Elowen* control-plane tools or API token.
        admin: match.admin === true,
        projectIds: (match.projectIds ?? []).map(Number),
        prompt: rolePrompt(match),
        model: chosen ? { provider: chosen.provider, model: chosen.model } : undefined,
        thinkingLevel: typeof st.thinkingLevel === 'string' ? st.thinkingLevel : undefined,
        fast: st.fast === true,
        tools: Array.isArray(match.tools) && match.tools.length > 0 ? match.tools : undefined,
      },
    };
  }

  /** The model selected for a conversation (per-chat override, else the catalog default). */
  modelForChannel(conversationId, models) {
    const chosen = this.state.get(String(conversationId)).model;
    return chosen
      ? models.find((m) => m.provider === chosen.provider && m.model === chosen.model)
      : (models.find((m) => m.default === true) ?? models[0]);
  }

  /** The sender's UPN/email via the conversation roster (bot API, no Graph permission), cached per
   *  account id. Best-effort — a failed lookup just narrows policy matching to id/GUID forms. */
  async resolveUpn(serviceUrl, conversationId, from) {
    if (!from?.id) return undefined;
    if (this.upnCache.has(from.id)) return this.upnCache.get(from.id);
    try {
      const member = await this.connector.member(serviceUrl, conversationId, from.id);
      const upn = member?.userPrincipalName || member?.email || undefined;
      this.upnCache.set(from.id, upn);
      return upn;
    } catch {
      this.upnCache.set(from.id, undefined);
      return undefined;
    }
  }

  async onActivity(m) {
    const conv = m.conversation;
    const from = m.from;
    if (!conv?.id || !from || from.id === m.recipient?.id) return; // no conversation, or our own echo
    this.rememberConversation(m);

    // Personal chats always respond. Group chats respond per config; a team-channel post reaches the
    // bot only when @mentioned anyway, and the mention gate doubles as the guard for group chats too.
    const kind = conv.conversationType ?? 'personal';
    if (kind !== 'personal' && this.cfg.respondWithoutMention === false && !this.isForMe(m)) return;

    const upn = await this.resolveUpn(m.serviceUrl, conv.id, from);
    const ids = senderIds(from, conv.id, upn);
    const { access } = this.accessFor(ids, conv.id);
    if (!access) return; // unmapped sender → stay silent

    let text = this.stripMention(m.text);

    // A slash command targets the bot's controls, not the brain.
    if (text.startsWith('/') && await this.handleCommand(m, conv, from, ids, text)) return;
    // A recognized plugin prompt-command falls through handleCommand: capture its RAW `/name args` so it
    // reaches the brain starting with the slash (PI expands the macro), bypassing the `[sender]` prefix.
    const promptSlash = this.isPromptCommand(text) ? text : null;

    const { images, notes } = await this.collectMedia(m);
    if (notes.length) text = [text, ...notes].filter(Boolean).join('\n');
    if (!text && images.length) text = '[The user sent an image]';
    if (!text) return;

    // Chat sessions are SHARED (one conversation per chat), so every message names its speaker.
    const senderName = displayNameOf(from);
    const prefixed = `[${senderName}] ${text}`;

    const gen = this.state.get(String(conv.id)).gen ?? 0;
    const convoKey = `${conv.id}#${gen}`;

    const display = resolveDisplaySettings(this.cfg, this.state.get(String(conv.id)));
    const observesLiveEvents = display.toolActivity !== 'off' || display.answerMode === 'live' || this.cfg.showReasoning === true;
    const stream = observesLiveEvents ? new LiveMessage(this, conv.id, m.id, from.id, display) : null;
    // Even with live streaming OFF, AskUserQuestion must still render its card — otherwise the parked
    // turn hangs until the timeout. Route events through the stream when present, else handle only `ask`.
    const onEvent = stream
      ? (e) => stream.onEvent(e)
      : (e) => { if (e.type === 'ask' && Array.isArray(e.questions)) void this.postAsk(conv.id, m.id, from.id, e.id, e.questions).catch(() => {}); };

    const typing = setInterval(() => void this.connector.typing(m.serviceUrl, conv.id).catch(() => {}), TYPING_INTERVAL_MS);
    void this.connector.typing(m.serviceUrl, conv.id).catch(() => {});

    // Image turns steer to the configured vision model — the chat's normal model may be text-only.
    const vision = images.length ? parseModelExec(this.cfg.visionModel) : null;
    let turnAccess = access;
    if (vision) {
      const models = await this.listModels().catch(() => []);
      const visionOption = models.find((mo) => mo.model === vision.model && (!vision.provider || mo.provider === vision.provider));
      turnAccess = { ...access, model: vision, ...(!visionOption?.fastAvailable ? { fast: false } : {}) };
    }

    try {
      const replyText = await this.handler(
        {
          platform: 'msteams', userId: String(from.aadObjectId || from.id), userName: senderName, roleIds: ids,
          channelId: convoKey, access: turnAccess,
          channelName: kind !== 'personal' ? (conv.name || undefined) : undefined,
          images: images.length ? images : undefined,
        },
        promptSlash ?? prefixed,
        onEvent,
      );
      clearInterval(typing);
      if (stream) await stream.finalize(replyText);
      else if (replyText) await postWithImages(this, conv.id, replyText, m.id);
    } catch (e) {
      clearInterval(typing);
      if (stream) await stream.fail(e?.message ?? e); // settle live tools before the error reply lands below them
      await this.tmSend(conv.id, this.msg.error(e?.message ?? e), { replyToId: m.id }).catch(() => {});
    }
  }

  /** Vision-ready images from the activity's attachments (downloaded + base64, capped) and textual notes
   *  for everything else. Teams duplicates the message body as a text/html attachment — skipped. */
  async collectMedia(m) {
    const images = [];
    const notes = [];
    const maxImageBytes = cfgNum(this.cfg, 'maxImageBytes', MAX_IMAGE_BYTES, 1048576, 20971520);
    const maxImages = cfgNum(this.cfg, 'maxImages', MAX_IMAGES, 1, 10);
    for (const a of m.attachments ?? []) {
      const type = String(a?.contentType ?? '');
      if (type === 'text/html' || type === 'text/plain') continue; // the body's own echo
      if (type.startsWith('image/') && typeof a.contentUrl === 'string') {
        if (images.length >= maxImages) continue;
        try {
          const buf = await this.connector.download(a.contentUrl, maxImageBytes);
          images.push({ data: buf.toString('base64'), mimeType: type });
        } catch (e) {
          notes.push('[Attachment: image (download failed or too large)]');
          this.log.error(`image download failed: ${e?.message ?? e}`);
        }
      } else if (a?.name) {
        notes.push(`[Attachment: ${a.name} (${type || 'unknown'})]`);
      }
    }
    return { images, notes };
  }

  // ── outbound transport (the tm* helpers the live stream + commands ride) ──

  /** Send text (or a card via extra.card) into a conversation; returns the new activity id or null.
   *  `extra.replyToId` threads it under the trigger. */
  async tmSend(conversationId, content, extra = {}) {
    const serviceUrl = this.serviceUrlFor(conversationId);
    if (!serviceUrl) { this.log.warn(`msteams send: no stored route for conversation ${conversationId}`); return null; }
    const activity = extra.card
      ? { type: 'message', attachments: [extra.card] }
      : { type: 'message', textFormat: 'markdown', text: String(content) };
    try {
      return extra.replyToId
        ? (await this.connector.reply(serviceUrl, conversationId, extra.replyToId, activity)) ?? null
        : (await this.connector.send(serviceUrl, conversationId, activity)) ?? null;
    } catch (e) {
      this.log.error(`msteams send failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Edit a previously sent bot message in place; true when the edit landed. */
  async tmEdit(conversationId, activityId, content, card) {
    const serviceUrl = this.serviceUrlFor(conversationId);
    if (!serviceUrl || !activityId) return false;
    const activity = card
      ? { type: 'message', attachments: [card] }
      : { type: 'message', textFormat: 'markdown', text: String(content) };
    try {
      await this.connector.update(serviceUrl, conversationId, activityId, activity);
      return true;
    } catch (e) {
      this.log.warn(`msteams edit failed: ${e?.message ?? e}`);
      return false;
    }
  }

  async tmDelete(conversationId, activityId) {
    const serviceUrl = this.serviceUrlFor(conversationId);
    if (!serviceUrl || !activityId) return;
    await this.connector.remove(serviceUrl, conversationId, activityId).catch(() => {});
  }

  /** Generated-image files (by name, from the image plugins' data dirs) as upload-ready buffers. */
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

  /** Attach images as inline data-URI attachments (Teams renders these in the message body). */
  async sendImages(conversationId, files) {
    const serviceUrl = this.serviceUrlFor(conversationId);
    if (!serviceUrl || !files.length) return;
    const attachments = files.map((f) => ({
      contentType: f.name.toLowerCase().endsWith('.jpg') || f.name.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      contentUrl: `data:${f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'};base64,${f.data.toString('base64')}`,
      name: f.name,
    }));
    await this.connector.send(serviceUrl, conversationId, { type: 'message', attachments }).catch((e) => this.log.error(`image upload failed: ${e?.message ?? e}`));
  }

  /** Host `send` (bound-session output): strip the /new generation suffix and post to the stored ref. */
  async send(channelId, text) {
    const conversationId = String(channelId).replace(/#\d+$/, '');
    for (const piece of splitContent(String(text))) {
      await this.tmSend(conversationId, piece);
    }
  }

  // ── proactive + tools ──

  /** Host-initiated push (cron/tick echoes) → an explicit target or the configured notification
   *  conversation. A target without a stored ref is treated as a user (Entra object id) and the
   *  personal conversation is opened via the connector — Teams hands back the existing chat for a
   *  known pair. No-op (with a warn) until the bot has seen at least one activity: proactive sends
   *  ride the last known serviceUrl. */
  async notify(text, channelId) {
    const target = (typeof channelId === 'string' && channelId.trim().replace(/#\d+$/, ''))
      || (typeof this.cfg.notifyConversationId === 'string' ? this.cfg.notifyConversationId.trim() : '');
    if (!target) return;
    const serviceUrl = this.serviceUrlFor(target);
    if (!serviceUrl) { this.log.warn('msteams notify: no serviceUrl known yet — send the bot one message first'); return; }
    let conversationId = target;
    if (!this.state.get(target).ref) {
      conversationId = this.notifyConversations.get(target) ?? await this.connector.createConversation(serviceUrl, {
        bot: { id: `28:${this.cfg.appId}` },
        members: [{ id: target }],
        tenantId: this.cfg.tenantId,
        isGroup: false,
      });
      if (!conversationId) { this.log.warn(`msteams notify: could not open a conversation with ${target}`); return; }
      this.notifyConversations.set(target, conversationId);
    }
    for (const piece of splitContent(String(text))) {
      await this.tmSend(conversationId, piece);
    }
  }

  /** The connector route for a conversation, or a thrown error — used by the Teams* tools. */
  requireServiceUrl(conversationId) {
    const serviceUrl = this.serviceUrlFor(conversationId);
    if (!serviceUrl) throw new Error('the bot has no route to this conversation yet — it must receive a message first');
    return serviceUrl;
  }

  /** The sideloadable Teams app package (manifest + icons), served by GET /plugins/msteams/app-package. */
  appPackage() {
    return buildAppPackage(this.cfg, this.helpCommands());
  }

  /** Raw connector REST access (the owner-only TeamsApi tool): any method+path on the service host. */
  async callApi(method, path, body, serviceUrl) {
    const base = serviceUrl || this.state.get('_meta').serviceUrl;
    if (!base) throw new Error('no serviceUrl known yet — the bot must receive a message first');
    const cleanPath = String(path).startsWith('/') ? String(path) : `/${path}`;
    return this.connector.call(base, String(method).toUpperCase(), cleanPath, body);
  }

  // ── AskUserQuestion cards ──

  askTtlMs() { return cfgNum(this.cfg, 'askTimeoutMs', ASK_TTL_MS, 30000, 1800000); }

  /** Post the choice card for a parked AskUserQuestion and remember it under a short token. */
  async postAsk(conversationId, replyToId, askerId, id, questions) {
    const token = String(++this.askSeq);
    const selected = questions.map(() => []);
    const cs = this.cfg.language === 'cs';
    const activityId = await this.tmSend(conversationId, '', { replyToId, card: buildAskCard(token, questions, { cs, selected }) });
    this.pendingAsks.set(token, { id, conversationId, activityId, questions, askerId, selected, createdAt: Date.now() });
  }

  /** An Adaptive Card Action.Submit round-trip (`activity.value`) — ask answers and picker choices. */
  async onCardAction(m) {
    const conv = m.conversation;
    const from = m.from;
    if (!conv?.id || !from) return;
    this.rememberConversation(m);
    const value = m.value ?? {};
    if (value.ea !== undefined) return this.onAskAction(m, conv, from, value);
    if (value.ep !== undefined) return this.onPickerAction(m, conv, from, value);
  }

  async onAskAction(m, conv, from, value) {
    const token = String(value.ea);
    const pend = this.pendingAsks.get(token);
    if (!pend) return;
    if (Date.now() - pend.createdAt > this.askTtlMs()) {
      this.pendingAsks.delete(token);
      if (pend.activityId) await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.askExpired));
      return;
    }
    // Only the person the question was routed to (or an operator) may answer.
    const upn = await this.resolveUpn(m.serviceUrl, conv.id, from);
    const ids = senderIds(from, conv.id, upn);
    const senderKey = String(from.aadObjectId || from.id);
    if (senderKey !== String(pend.askerId) && !this.isAdmin(ids)) {
      await this.tmSend(conv.id, this.msg.askForSomeoneElse, { replyToId: m.id });
      return;
    }
    const cs = this.cfg.language === 'cs';
    const single = pend.questions.length === 1 && pend.questions[0]?.multiSelect !== true;

    if (value.o !== undefined && value.q !== undefined) {
      const qi = Number(value.q);
      const oi = Number(value.o);
      const label = pend.questions[qi]?.options?.[oi]?.label;
      if (label === undefined) return;
      const multi = pend.questions[qi]?.multiSelect === true;
      const picks = pend.selected[qi] ?? [];
      pend.selected[qi] = multi
        ? (picks.includes(label) ? picks.filter((l) => l !== label) : [...picks, label])
        : [label];
      if (single) return this.settleAsk(token, pend);
      // Re-render the card so the ✅ marks reflect the current selection.
      await this.tmEdit(pend.conversationId, pend.activityId, '', buildAskCard(token, pend.questions, { cs, selected: pend.selected }));
      return;
    }
    if (value.ot !== undefined) {
      const other = String(value.other ?? '').trim();
      if (!other) return;
      return this.settleAsk(token, pend, other);
    }
    if (value.s !== undefined) return this.settleAsk(token, pend);
  }

  /** Deliver the collected answers to the parked turn and settle the card to a summary line. */
  async settleAsk(token, pend, other) {
    const answers = pend.questions.map((q, qi) => ({
      header: q.header,
      selected: pend.selected[qi] ?? [],
      ...(other !== undefined && qi === 0 ? { other } : {}),
    }));
    const settled = this.answerQuestion(pend.id, answers);
    this.pendingAsks.delete(token);
    const summary = answers
      .map((a) => `${a.header}: ${[...a.selected, ...(a.other ? [a.other] : [])].join(', ') || '—'}`)
      .join(' · ');
    if (pend.activityId) {
      await this.tmEdit(pend.conversationId, pend.activityId, '', settledCard(settled ? this.msg.askAnswered(summary) : this.msg.askExpired));
    }
  }

  // ── slash commands ──

  /** True when a `/slash` invocation names a plugin prompt macro (kind:'prompt') — routed RAW to the brain. */
  isPromptCommand(text) {
    if (!text.startsWith('/')) return false;
    const name = text.slice(1).trim().split(/\s+/)[0]?.toLowerCase();
    return !!name && this.chatCommands().some((c) => c.name === name && c.kind === 'prompt');
  }

  helpCommands() {
    return [
      ...this.chatCommands(),
      { name: 'display', description: 'configure live tools and answer delivery here' },
    ];
  }

  /** Handle a `/command`. Returns true when the text was a (recognized) command. */
  async handleCommand(m, conv, from, ids, text) {
    const [cmdRaw, ...argParts] = text.slice(1).trim().split(/\s+/);
    const cmd = String(cmdRaw ?? '').toLowerCase();
    const arg = argParts.join(' ').trim().toLowerCase();
    const admin = () => this.isAdmin(ids);
    const reply = (t) => this.tmSend(conv.id, t, { replyToId: m.id });
    const cs = this.cfg.language === 'cs';

    if (CONTROL_COMMANDS.has(cmd)) {
      return runControlCommand(cmd, {
        msg: this.msg, reply, isAdmin: admin, arg,
        state: this.state, stateId: String(conv.id), ctl: this.ctl, ref: this.channelRef(conv.id),
        activeModel: async () => this.modelForChannel(conv.id, await this.listModels().catch(() => [])),
        fastEnabled: this.chatCommands().some((c) => c.name === 'fast'),
      });
    }
    switch (cmd) {
      case 'help':
        await reply(this.msg.help(this.cfg.agentName || 'Elowen', this.helpCommands()));
        return true;
      case 'model': {
        if (!admin()) { await reply(this.msg.modelForbidden); return true; }
        const models = await this.listModels().catch(() => []);
        if (!models.length) { await reply(this.msg.noModels); return true; }
        const current = this.modelForChannel(conv.id, models);
        const options = models.map((mo) => ({ label: `${mo.model} (${mo.providerLabel ?? mo.provider})`, value: `${mo.provider} ${mo.model}` }));
        const activityId = await this.tmSend(conv.id, '', { replyToId: m.id, card: buildPickerCard('model', this.msg.pickModel, options, { cs, current: current ? `${current.provider} ${current.model}` : undefined }) });
        this.pendingPickers.set(String(conv.id), { kind: 'model', options, activityId, page: 0, senderId: String(from.aadObjectId || from.id), createdAt: Date.now() });
        return true;
      }
      case 'reasoning': {
        if (!admin()) { await reply(this.msg.modelForbidden); return true; }
        const models = await this.listModels().catch(() => []);
        if (!models.length) { await reply(this.msg.noModels); return true; }
        const active = this.modelForChannel(conv.id, models);
        const levels = Array.isArray(active?.reasoningLevels) ? active.reasoningLevels : [];
        if (!levels.length) { await reply(this.msg.reasoningUnavailable); return true; }
        const current = this.state.get(String(conv.id)).thinkingLevel ?? '';
        const options = [{ label: this.msg.reasoningDefault, value: '' }, ...levels.map((l) => ({ label: l, value: l }))];
        const activityId = await this.tmSend(conv.id, '', { replyToId: m.id, card: buildPickerCard('reasoning', this.msg.pickThinking, options, { cs, current }) });
        this.pendingPickers.set(String(conv.id), { kind: 'reasoning', options, activityId, page: 0, senderId: String(from.aadObjectId || from.id), createdAt: Date.now() });
        return true;
      }
      case 'display': {
        if (!admin()) { await reply(this.msg.controlForbidden); return true; }
        await this.postDisplayPicker(conv.id, m.id, from);
        return true;
      }
      case 'context': {
        if (!admin()) { await reply(this.msg.controlForbidden); return true; }
        const listing = this.ctl?.listContext?.(this.channelRef(conv.id), String(from.aadObjectId || from.id), { offset: 0, limit: CONTEXT_MAX }) ?? null;
        if (!listing || !listing.items.length) { await reply(this.msg.noContextSessions); return true; }
        const options = listing.items.map((s) => ({ label: `${s.title || s.id} · ${s.model}`, value: s.id }));
        const activityId = await this.tmSend(conv.id, '', { replyToId: m.id, card: buildPickerCard('context', this.msg.pickContext, options, { cs }) });
        this.pendingPickers.set(String(conv.id), { kind: 'context', options, activityId, page: 0, senderId: String(from.aadObjectId || from.id), createdAt: Date.now() });
        return true;
      }
      default:
        return false; // unknown → falls through (a prompt macro reaches the brain raw; anything else is chat)
    }
  }

  /** The /display card: one row of options per axis, current values marked. */
  async postDisplayPicker(conversationId, replyToId, from) {
    const cs = this.cfg.language === 'cs';
    const current = resolveDisplaySettings(this.cfg, this.state.get(String(conversationId)));
    const options = [];
    for (const [axis, values] of Object.entries(DISPLAY_AXES)) {
      for (const v of values) options.push({ label: `${axis}: ${v}`, value: `${axis} ${v}` });
    }
    const marked = Object.entries(current).map(([axis, v]) => `${axis} ${v}`);
    const activityId = await this.tmSend(conversationId, '', { replyToId, card: buildPickerCard('display', this.msg.pickDisplay, options, { cs, current: marked[0] }) });
    this.pendingPickers.set(String(conversationId), { kind: 'display', options, activityId, page: 0, senderId: String(from.aadObjectId || from.id), createdAt: Date.now() });
  }

  async onPickerAction(m, conv, from, value) {
    const pend = this.pendingPickers.get(String(conv.id));
    if (!pend || pend.kind !== value.ep) return;
    const upn = await this.resolveUpn(m.serviceUrl, conv.id, from);
    const ids = senderIds(from, conv.id, upn);
    if (!this.isAdmin(ids) && String(from.aadObjectId || from.id) !== pend.senderId) return;
    const cs = this.cfg.language === 'cs';

    if (value.p !== undefined) { // page turn — re-render the same card window
      pend.page = Number(value.p) || 0;
      const title = pend.kind === 'model' ? this.msg.pickModel : pend.kind === 'reasoning' ? this.msg.pickThinking : pend.kind === 'context' ? this.msg.pickContext : this.msg.pickDisplay;
      await this.tmEdit(conv.id, pend.activityId, '', buildPickerCard(pend.kind, title, pend.options, { cs, page: pend.page }));
      return;
    }
    const picked = String(value.v ?? '');
    switch (pend.kind) {
      case 'model': {
        const sep = picked.indexOf(' ');
        if (sep <= 0) return;
        const provider = picked.slice(0, sep);
        const model = picked.slice(sep + 1);
        if (!model) return;
        this.state.patch(String(conv.id), { model: { provider, model } });
        this.pendingPickers.delete(String(conv.id));
        await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.modelSet(model)));
        return;
      }
      case 'reasoning': {
        this.state.patch(String(conv.id), { thinkingLevel: picked || undefined });
        this.pendingPickers.delete(String(conv.id));
        await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.thinkingSet(picked || this.msg.reasoningDefaultValue)));
        return;
      }
      case 'display': {
        const sep = picked.indexOf(' ');
        if (sep <= 0) return;
        const axis = picked.slice(0, sep);
        const v = picked.slice(sep + 1);
        if (!v) return;
        const st = this.state.get(String(conv.id));
        this.state.patch(String(conv.id), { display: updateDisplayOverrides(st.display, { [axis]: v }) });
        this.pendingPickers.delete(String(conv.id));
        await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.displaySet(resolveDisplaySettings(this.cfg, this.state.get(String(conv.id))))));
        return;
      }
      case 'context': {
        this.pendingPickers.delete(String(conv.id));
        try {
          const bound = await this.ctl?.bindContext?.(this.channelRef(conv.id), String(from.aadObjectId || from.id), picked);
          await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.contextBound(bound?.title)));
        } catch (e) {
          await this.tmEdit(conv.id, pend.activityId, '', settledCard(this.msg.contextError(e?.message ?? e)));
        }
        return;
      }
      default:
    }
  }
}
