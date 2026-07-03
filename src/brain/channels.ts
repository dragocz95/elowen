import type { BrainStore } from '../store/brainStore.js';
import type { Policy } from '../plugins/policy.js';
import type { TurnIdentity } from '../plugins/policyContext.js';
import { runWithPolicy } from '../plugins/policyContext.js';
import type { BrainEvent } from './events.js';
import { usageOf } from './events.js';
import { projectUserTurn } from './persistence.js';
import { extractText } from './messageView.js';
import { channelSessionId } from './sessionId.js';
import type { LiveSessionRegistry } from './session/liveRegistry.js';
import type { LiveBrain, SpawnOpts } from './session/liveBrain.js';
import { DEFAULT_AUTO_COMPACT_AT } from './session/liveBrain.js';

export interface ChannelSendOpts {
  channelId: string;
  ownerUserId: number;
  policy: Policy;
  promptAppend?: string[];
  /** Sender holds the operator's admin role: elevates the channel session to `trusted-channel`
   *  (all-project Policy + full plugin toolset) — but it is STILL a shared channel, never owner-chat,
   *  so it never receives orca_* tools or the owner API token. */
  trusted?: boolean;
  model?: { provider?: string; model?: string };
  thinkingLevel?: string;
  tools?: string[];
  images?: { data: string; mimeType: string }[];
  identity?: TurnIdentity;
  history?: () => Promise<string>;
  onEvent?: (e: BrainEvent) => void;
}

export interface ChannelServiceDeps {
  /** The SAME registry instance the chat brain uses — channel locks and LRU live in one place. */
  registry: LiveSessionRegistry<LiveBrain>;
  store: BrainStore;
  users: { get(userId: number): { name?: string; username?: string } | null | undefined };
  /** Session composition stays in BrainService.spawnLive — this service only orchestrates. */
  spawn: (opts: SpawnOpts) => Promise<LiveBrain>;
  /** Live channel sessions cap: past this the least-recently-used one is disposed (its history stays
   *  in SQLite and rehydrates on the next message), so a busy server can't leak sessions. */
  maxChannels?: number;
}

/** Platform channel conversations (Discord threads, …): one session per channel — keyed by the
 *  channel, NOT the Orca user — run with the caller-resolved Policy (role → projects) plus optional
 *  role prompt fragments. Persisted like any brain conversation (`brain-ch-<id>`), owned by
 *  `ownerUserId` (whose token drives the tools). */
export class ChannelSessionService {
  private readonly maxChannels: number;

  constructor(private d: ChannelServiceDeps) {
    this.maxChannels = d.maxChannels ?? 32;
  }

  /** Send one channel message into that channel's own conversation; resolves with the final
   *  assistant text. Serialized per channel: two rapid messages must not prompt() one PI session
   *  concurrently (and must not both spawn it). */
  async send(opts: ChannelSendOpts, text: string): Promise<string> {
    const sessionId = channelSessionId(opts.channelId);
    return this.d.registry.withLock(sessionId, async () => {
      // A BRAND-NEW conversation (no stored turns) may backfill what the platform channel said before
      // the brain joined — fetched lazily so an ongoing conversation never pays for it. Prepended to
      // the first user message (not the system prompt) so it persists as normal history.
      if (opts.history && this.d.store.getMessages(sessionId).length === 0) {
        const past = await opts.history().catch(() => '');
        if (past.trim()) text = `${past.trim()}\n\n${text}`;
      }
      let ch = this.d.registry.channelGet(opts.channelId);
      // A model or reasoning-effort switch mid-conversation rebuilds the session (history rehydrates).
      const modelChanged = !!opts.model?.model && ch?.model !== opts.model.model;
      const thinkingChanged = !!ch && (ch.thinkingLevel ?? '') !== (opts.thinkingLevel ?? '');
      if (ch && (modelChanged || thinkingChanged)) { this.d.registry.channelDispose(opts.channelId); ch = undefined; }
      if (!ch) {
        this.d.registry.channelEvictOldestIfFull(this.maxChannels);
        ch = await this.d.spawn({
          sessionId,
          ownerUserId: opts.ownerUserId,
          selection: opts.model ?? {},
          policy: opts.policy,
          extraAppend: opts.promptAppend,
          channel: true, // a shared platform channel is NEVER owner-chat — no orca_* tools, no owner token
          trustedChannel: opts.trusted, // admin-role sender → trusted-channel (all projects + full plugin toolset), still no orca_*
          toolFilter: opts.tools,
          thinkingLevel: opts.thinkingLevel,
          // Channels are the shared, owner-anchored Discord surface — the personality chunk always resolves
          // the OWNER's 'discord' active profile (never the per-sender id: that persona would leak to the
          // next sender in the shared session). 'discord' is the only locked channel platform, so it's
          // hardcoded here rather than threaded through ChannelSendOpts.
          platform: 'discord',
          autoCompact: true, // channels are long-lived and unattended — keep their context bounded
          autoCompactAt: DEFAULT_AUTO_COMPACT_AT,
        });
      }
      this.d.registry.channelTouch(opts.channelId, ch); // (re-)insert → Map order doubles as LRU order
      // Same image handling as send(): history keeps a marker, the pixels ride only the live prompt.
      projectUserTurn(this.d.store, sessionId, opts.images?.length ? `${text}\n[📎 ${opts.images.length}× obrázek]` : text);
      const prompted = ch.turnContext() + text;
      const options = opts.images?.length
        ? { images: opts.images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })) }
        : undefined;
      // Optional live streaming (Discord edit-in-place): forward this turn's events to the caller.
      const onEvent = opts.onEvent;
      const detach = onEvent ? (ch.listeners.add(onEvent), () => ch.listeners.delete(onEvent)) : undefined;
      try {
        await runWithPolicy(opts.policy, () => (options ? ch.session.prompt(prompted, options) : ch.session.prompt(prompted)), opts.identity);
        // Hand the caller a settled idle (model + context fill) deterministically, AFTER the turn ends.
        // Proactive footers (every cron push builds `model · N %` from this) must not depend on the
        // stream's own idle winning the race against prompt() resolution — otherwise the footer is
        // silently dropped. A duplicate is harmless: onEvent consumers just overwrite their last idle.
        onEvent?.({ type: 'idle', model: ch.model, usage: usageOf(ch.session) });
      } finally { detach?.(); }
      const usage = ch.session.getContextUsage();
      if (usage?.tokens && usage.contextWindow > 0 && usage.tokens / usage.contextWindow >= ch.autoCompactAt) {
        try { await ch.session.compact(); } catch { /* best-effort */ }
      }
      // The reply = the last assistant message of the settled turn.
      const msgs = ch.session.messages as { role?: string }[];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      return last ? extractText(last) : '';
    });
  }

  /** Shared-channel system-prompt fragment: names the room (and its topic) and pins the multi-user
   *  etiquette — senders arrive `[name]`-prefixed and are usually NOT the instance owner, so the brain
   *  must never address a stranger as the owner. Applied only when the channel session spawns via
   *  `promptAppend` → `extraAppend`; a later channel-name/topic change takes effect once the session
   *  respawns (LRU eviction or a /new reset). */
  fragmentFor(src: { platform: string; channelName?: string; channelTopic?: string }, ownerUserId: number): string {
    const u = this.d.users.get(ownerUserId);
    const ownerName = u?.name || u?.username || 'the owner';
    const platform = src.platform.charAt(0).toUpperCase() + src.platform.slice(1);
    const topic = src.channelTopic?.trim() ? ` The channel topic is: "${src.channelTopic.trim()}".` : '';
    return `You are talking on ${platform} in #${src.channelName}.${topic}\n`
      + `This is a shared channel: each user message is prefixed with the sender's name in [brackets]. `
      + `Address each sender by their bracketed name — the person talking to you is usually NOT ${ownerName}, `
      + `whose Orca instance you run on. Never assume the sender is ${ownerName} unless the prefix says so.`;
  }
}
