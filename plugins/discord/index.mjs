// Discord platform plugin: a dependency-free gateway client (Node's global WebSocket + fetch).
// The bot answers when mentioned (or DM'd); the sender's Discord roles resolve — via this plugin's
// own rolePolicies config — to the Orca projects they may touch plus an extra role prompt (the
// Hermes role-instructions pattern). Unmapped senders are ignored.
const API = 'https://discord.com/api/v10';
// GUILDS + GUILD_MESSAGES + MESSAGE_CONTENT + DIRECT_MESSAGES
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15) | (1 << 12);

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
    const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
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
    if (frame.op === 10) { // hello → heartbeat + identify
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send({ op: 1, d: this.seq }), frame.d.heartbeat_interval);
      this.send({ op: 2, d: { token: this.cfg.botToken, intents: INTENTS, properties: { os: 'linux', browser: 'orca', device: 'orca' } } });
      return;
    }
    if (frame.op === 0 && frame.t === 'READY') { this.backoffMs = 1000; this.log.info('discord gateway ready'); return; }
    if (frame.op === 0 && frame.t === 'MESSAGE_CREATE') void this.onMessage(frame.d).catch((e) => this.log.error(`message handling failed: ${e?.message ?? e}`));
    if (frame.op === 7 || frame.op === 9) { try { this.ws?.close(); } catch { /* reconnect via onclose */ } }
  }

  send(obj) { try { this.ws?.send(JSON.stringify(obj)); } catch { /* gateway down; reconnect handles it */ } }

  async onMessage(m) {
    if (!this.handler || m.author?.bot) return;
    if (this.cfg.guildId && m.guild_id && m.guild_id !== this.cfg.guildId) return;
    const isDm = !m.guild_id;
    const mentioned = (m.mentions ?? []).some((u) => u.id === this.botId);
    if (!isDm && !mentioned) return; // in servers the bot only answers when addressed

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

  async rest(method, path, body) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${this.cfg.botToken}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
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
