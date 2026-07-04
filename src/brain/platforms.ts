import type { PluginRegistry } from '../plugins/registry.js';
import type { Policy } from '../plugins/policy.js';
import type { IdentityResolver } from './identity.js';
import type { ChannelSessionService } from './channels.js';

export interface PlatformOrchestratorDeps {
  /** The daemon-wide plugin registry resolver (undefined when plugins aren't wired). */
  plugins: () => Promise<PluginRegistry | undefined>;
  /** The Orca user that anchors platform channel sessions (the admin). */
  platformOwner?: () => number | undefined;
  /** Build a Policy from an explicit project-id set (platform role mappings resolve through this). */
  policyForProjects?: (projectIds: number[]) => Policy;
  identity: IdentityResolver;
  channels: ChannelSessionService;
}

/** Lifecycle + turn pipeline of the plugin-contributed platform adapters (Discord bot, …): connect
 *  them, translate each inbound message into a channel-session turn (policy → identity → send), and
 *  fan proactive notifications out to them. Fail-open per adapter — one broken platform must not
 *  block the rest. */
export class PlatformOrchestrator {
  private started: { name: string; disconnect?(): void; notify?(t: string, channelId?: string): Promise<void> }[] = [];

  constructor(private d: PlatformOrchestratorDeps) {}

  /** Start every platform adapter: wire its messages into channel sessions and let it deliver the
   *  replies. Called once at daemon startup and re-run by reloadPlugins. */
  async startAll(log?: { info(m: string): void; error(m: string): void }): Promise<void> {
    const plugins = await this.d.plugins();
    for (const adapter of plugins?.platforms ?? []) {
      try {
        adapter.listen(async (src, text, onEvent) => {
          const owner = this.d.platformOwner?.();
          if (owner === undefined || !src.access) return undefined; // unmapped sender → stay silent
          // An admin-role sender gets all-project Policy + the full plugin toolset (trusted-channel);
          // a role-scoped sender gets only their role's projects and tool allowlist. NEITHER ever gets
          // the owner's orca_* API tools or token — a shared channel is never the verified owner's own
          // chat, whatever role the sender holds.
          const policy: Policy = src.access.admin
            ? { allowedProjectIds: 'all' as const, allowedPaths: () => [] }
            : this.d.policyForProjects?.(src.access.projectIds)
              ?? { allowedProjectIds: new Set(src.access.projectIds), allowedPaths: () => [] };
          const promptAppend = [
            ...(src.access.prompt ? [src.access.prompt] : []),
            ...(src.channelName ? [this.d.channels.fragmentFor(src, owner)] : []),
          ];
          // Per-turn sender identity + the verified-identity line for linked accounts (sanitized
          // against prompt injection through display names) — minted by the IdentityResolver, the
          // one auditable place `owner` vs `admin` semantics live.
          const { identity, verifiedPrefix, linkedUserId } = this.d.identity.forPlatformTurn(src, owner);
          return this.d.channels.send({
            channelId: `${src.platform}-${src.threadId ?? src.channelId}`,
            ownerUserId: owner,
            policy,
            promptAppend: promptAppend.length ? promptAppend : undefined,
            trusted: src.access.admin, // admin role → trusted-channel (all plugin tools), NOT owner-chat
            model: src.access.model,
            thinkingLevel: src.access.thinkingLevel,
            tools: src.access.admin ? undefined : src.access.tools, // admin → full plugin toolset; else role allowlist
            images: src.images,
            identity,
            // The Orca account this sender is verified as — memory recall/save keys on it. Unlinked
            // senders have no linkedUserId, so the channel turn gets no memory (shared-space privacy).
            writerUserId: linkedUserId,
            history: src.history,
            onEvent,
          }, verifiedPrefix + text);
        });
        await adapter.connect();
        this.started.push(adapter);
        log?.info(`platform connected: ${adapter.name}`);
      } catch (e) {
        log?.error(`platform failed: ${adapter.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Disconnect every started adapter (reloadPlugins rebuilds them from the fresh registry). */
  stopAll(): void {
    for (const p of this.started) { try { p.disconnect?.(); } catch { /* already down */ } }
    this.started = [];
  }

  /** Push a proactive message to every started platform that has a notification channel (Discord, …).
   *  Fail-open per adapter — a broken sink must not break the cron tick that triggered it. */
  async notify(text: string, channelId?: string): Promise<void> {
    for (const p of this.started) {
      if (typeof p.notify === 'function') {
        try { await p.notify(text, channelId); } catch { /* one sink down must not block the rest */ }
      }
    }
  }
}
