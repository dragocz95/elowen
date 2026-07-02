// Discord platform plugin: a dependency-free gateway client (Node's global WebSocket + fetch).
// The bot answers when mentioned in a server; the sender's Discord roles resolve — via this plugin's
// own rolePolicies config — to the Orca projects they may touch plus an extra role prompt (the
// Hermes role-instructions pattern). Unmapped senders (and DMs, which carry no roles) are ignored.
const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
// GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

class DiscordAdapter {
  name = 'discord';
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.log = logger;
    this.handler = null;
    this.ws = null;
    this.botId = null;
    this.stopped = false;
    this.seq = null;
    this.backoffMs = 1000;
    this.sessionId = null;    // gateway session for RESUME
    this.resumeUrl = null;    // gateway host to RESUME against
    this.awaitingAck = false; // heartbeat sent, ACK (op 11) not yet seen → zombie detection
  }

  listen(onMessage) { this.handler = onMessage; }

  async connect() {
    // Validate the token up front so a bad config fails loudly at startup, not silently in the gateway.
    const me = await this.rest('GET', '/users/@me');
    this.botId = me.id;
    this.openGateway();
  }

  disconnect() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    try { this.ws?.close(); } catch { /* already closed */ }
  }

  openGateway() {
    if (this.stopped) return;
    const ws = new WebSocket(this.sessionId && this.resumeUrl ? `${this.resumeUrl}?v=10&encoding=json` : GATEWAY);
    this.ws = ws;
    ws.onmessage = (ev) => this.onFrame(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.stopped) return;
      // Reconnect with capped backoff — a dropped gateway must never kill the daemon.
      setTimeout(() => this.openGateway(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    };
    ws.onerror = () => { /* onclose follows and handles the retry */ };
  }

  onFrame(frame) {
    if (frame.s) this.seq = frame.s;
    if (frame.op === 10) { // hello → heartbeat + identify/resume
      clearInterval(this.heartbeat);
      this.awaitingAck = false;
      this.heartbeat = setInterval(() => {
        // A heartbeat that was never ACKed means a zombie (half-open) connection — force a reconnect.
        if (this.awaitingAck) { try { this.ws?.close(); } catch { /* onclose reconnects */ } return; }
        this.awaitingAck = true;
        this.send({ op: 1, d: this.seq });
      }, frame.d.heartbeat_interval);
      if (this.sessionId) {
        this.send({ op: 6, d: { token: this.cfg.botToken, session_id: this.sessionId, seq: this.seq } });
      } else {
        this.send({ op: 2, d: { token: this.cfg.botToken, intents: INTENTS, properties: { os: 'linux', browser: 'orca', device: 'orca' } } });
      }
      return;
    }
    if (frame.op === 11) { this.awaitingAck = false; return; } // heartbeat ACK
    if (frame.op === 0 && frame.t === 'READY') {
      this.backoffMs = 1000;
      this.sessionId = frame.d.session_id ?? null;
      this.resumeUrl = frame.d.resume_gateway_url ?? null;
      this.log.info('discord gateway ready');
      return;
    }
    if (frame.op === 0 && frame.t === 'RESUMED') { this.backoffMs = 1000; return; }
    if (frame.op === 0 && frame.t === 'MESSAGE_CREATE') void this.onMessage(frame.d).catch((e) => this.log.error(`message handling failed: ${e?.message ?? e}`));
    if (frame.op === 7) { try { this.ws?.close(); } catch { /* reconnect via onclose */ } }
    if (frame.op === 9) { // invalid session: only resumable ones keep the session id
      if (!frame.d) { this.sessionId = null; this.resumeUrl = null; this.seq = null; }
      try { this.ws?.close(); } catch { /* reconnect via onclose */ }
    }
  }

  send(obj) { try { this.ws?.send(JSON.stringify(obj)); } catch { /* gateway down; reconnect handles it */ } }

  async onMessage(m) {
    if (!this.handler || m.author?.bot) return;
    if (!m.guild_id) return; // DMs carry no member roles → no policy can ever match; ignore them
    if (this.cfg.guildId && m.guild_id !== this.cfg.guildId) return;
    const mentioned = (m.mentions ?? []).some((u) => u.id === this.botId);
    if (!mentioned) return; // the bot only answers when addressed

    const text = String(m.content ?? '').replaceAll(`<@${this.botId}>`, '').replaceAll(`<@!${this.botId}>`, '').trim();
    if (!text) return;

    const roleIds = m.member?.roles ?? [];
    const policies = Array.isArray(this.cfg.rolePolicies) ? this.cfg.rolePolicies : [];
    const match = policies.find((p) => p.roleId && roleIds.includes(p.roleId));
    const access = match
      ? { projectIds: (match.projectIds ?? []).map(Number), prompt: rolePrompt(match) }
      : undefined; // unmapped → the host stays silent

    const reply = await this.handler({
      platform: 'discord', userId: m.author.id, roleIds,
      channelId: m.channel_id, access,
    }, text);
    if (reply) await this.reply(m.channel_id, reply);
  }

  async reply(channelId, text) {
    // Discord caps messages at 2000 chars — chunk long brain replies.
    for (let i = 0; i < text.length; i += 1990) {
      await this.rest('POST', `/channels/${channelId}/messages`, { content: text.slice(i, i + 1990) });
    }
  }

  /** Host-initiated push (cron/tick echoes) → the configured notification channel. No-op without one. */
  async notify(text) {
    const channelId = typeof this.cfg.notifyChannelId === 'string' ? this.cfg.notifyChannelId.trim() : '';
    if (!channelId) return;
    await this.reply(channelId, text);
  }

  async rest(method, path, body, attempt = 0) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${this.cfg.botToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 3) { // honor the rate limit and retry
      const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.rest(method, path, body, attempt + 1);
    }
    if (!res.ok) throw new Error(`discord API ${method} ${path} → HTTP ${res.status}`);
    return res.json();
  }
}

function rolePrompt(policy) {
  const parts = [];
  if (policy.name) parts.push(`The user you are talking to has the "${policy.name}" role.`);
  if (policy.prompt) parts.push(policy.prompt);
  return parts.join('\n') || undefined;
}

export function register(ctx) {
  const token = typeof ctx.config.botToken === 'string' ? ctx.config.botToken.trim() : '';
  if (!token) { ctx.logger.warn('enabled but no botToken configured — not connecting'); return; }
  ctx.registerPlatform(new DiscordAdapter({ ...ctx.config, botToken: token }, ctx.logger));
  ctx.logger.info('discord platform registered');
}
