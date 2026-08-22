import { operatesInstance } from '../shared/instanceOperator.js';
import type { TurnIdentity } from '../plugins/policyContext.js';
import type { Policy } from '../plugins/policy.js';
import type { SessionSource } from '../plugins/api.js';
import type { DelegatedExecutionScope } from './delegatedScope.js';

/** A platform sender resolved to the Elowen account that claimed the platform id in Account settings. */
interface LinkedUser { id: number; name: string; username?: string; admin: boolean }

export interface PlatformSenderAttribution { id: string; name: string }

/** Platform display names are attacker-controlled. Keep them inert as JSON values and bound by Unicode
 *  code points so astral characters count as one visible character rather than two UTF-16 code units. */
export function sanitizePlatformSenderName(value: unknown): string {
  return [...String(value ?? '').replace(/[[\]\r\n]/g, ' ').trim()].slice(0, 80).join('');
}

export interface IdentityDeps {
  /** The Elowen user that anchors platform channel sessions (the admin). Undefined = single-user mode. */
  platformOwner?: () => number | undefined;
  /** Resolve a platform sender, optionally using platform-verified e-mail evidence supplied structurally. */
  resolvePlatformUser?: (platform: string, platformUserId: string, verifiedEmail?: string) => LinkedUser | null;
  users: { get(userId: number): { username?: string; name?: string; is_admin?: boolean } | null | undefined };
}

/** The ONE place turn identities are minted — auditable, testable, and hard to fork by accident.
 *  `owner` marks a turn driven by someone who administers this instance: the operator themselves, any
 *  Elowen ACCOUNT holding the admin bit, or their own server-internal automation (cron/subagent). It is
 *  NEVER a foreign platform member who merely holds an admin-mapped room role — that trust stays in
 *  channel options and cannot mint an account. Identity `admin` tracks all-access policy scope. */
export class IdentityResolver {
  constructor(private d: IdentityDeps) {}

  /** Whether `userId` administers this instance — the turn-side half of `operatesInstance`, which carries
   *  the rule and the reasoning. The admin bit is read from the ACCOUNT here, never from a room role. */
  isOwner(userId: number | undefined): boolean {
    return operatesInstance({
      userId,
      ownerId: this.d.platformOwner?.(),
      isAdmin: userId === undefined ? false : this.d.users.get(userId)?.is_admin === true,
    });
  }

  /** The identity of a user driving their OWN authenticated Elowen chat (web dock / CLI). */
  forOwnerChat(userId: number, policy: Policy): TurnIdentity {
    return {
      platform: 'elowen',
      userId: String(userId),
      elowenUserId: userId, // their own authenticated chat — the account IS the sender
      elowenUsername: this.d.users.get(userId)?.username,
      admin: policy.allowedProjectIds === 'all',
      owner: this.isOwner(userId), // their own authenticated chat → operator
      conversation: 'own',
    };
  }

  /** Rehydrate the original identity of an idle delegated child. The child is never reinterpreted as
   * the account owner merely because that account owns its SQLite row: only the captured origin-owner
   * bit survives, and even that is meaningful only for the configured instance operator. */
  forDelegatedTurn(scope: DelegatedExecutionScope, ownerUserId: number): TurnIdentity {
    return {
      platform: 'subagent',
      userId: 'subagent',
      // Deliberately NO `elowenUserId`: the memory tools treat any identity carrying one as that account
      // acting (`memoryTools.ts` `actingUserId`), and a child spawned from a SHARED room inherits the row
      // owner — the instance operator. Naming the account here would let a turn steered by somebody else's
      // channel message read, write and delete the operator's private memory. A child is attributed to its
      // delegation, not to a person.
      admin: scope.admin,
      owner: scope.owner && this.isOwner(ownerUserId),
      conversation: 'delegated',
    };
  }

  /** The account a platform source declares it is acting for, as a linked-user view. Unknown id (a job
   *  whose owner was deleted) resolves to nothing, so the turn falls back to the source's own access
   *  rather than silently running as an account that no longer exists. */
  private actingUser(userId: number | undefined): LinkedUser | null {
    if (userId === undefined) return null;
    const row = this.d.users.get(userId);
    if (!row) return null;
    return { id: userId, name: row.name || row.username || String(userId), username: row.username, admin: row.is_admin === true };
  }

  /** The identity of a platform turn (Discord message, cron tick, subagent delegation) plus host-owned
   *  structured sender attribution. The attribution is serialized later as JSON for shared rooms; no
   *  attacker-controlled display name is ever interpolated into trusted prompt markup. */
  forPlatformTurn(src: SessionSource, _owner: number): { identity: TurnIdentity; sender?: PlatformSenderAttribution; accountUserId?: number; linkedUserId?: number } {
    let linked: LinkedUser | null = null;
    for (const platformUserId of [...new Set([src.userId, ...(src.accountIds ?? [])])]) {
      linked = this.d.resolvePlatformUser?.(src.platform, platformUserId, src.verifiedEmail) ?? null;
      if (linked) break;
    }
    // Server automation acting FOR one account (a cron job somebody owns). There is no platform id to
    // resolve — the plugin names the account and the host looks it up here. This supplies attribution and
    // personal deny-lists; the orchestrator still decides whether the surface is private account context or
    // a shared room. A real platform link always wins, so this can never override who a message actually came from.
    const account = linked ?? this.actingUser(src.access?.actAsUserId);
    // Only real inbound platform messages carry a human sender. Server automation (cron/subagent) has no
    // display-name claim to serialize, even when it acts for an account.
    const sender = src.platform !== 'cron' && src.platform !== 'subagent'
      ? { id: String(src.userId), name: sanitizePlatformSenderName(src.userName || src.userId) }
      : undefined;
    // Cron is owner-authored server automation. A subagent is different: it must carry the ORIGINAL
    // turn's owner truth explicitly, because a foreign platform role can legitimately have admin scope.
    // Deriving subagent ownership from `admin` would elevate that role into owner-only raw-token tools.
    const automationOwner = src.platform === 'cron'
      ? src.access?.admin === true
      : src.platform === 'subagent' && src.access?.owner === true;
    const identity: TurnIdentity = {
      platform: src.platform,
      userId: src.userId,
      elowenUserId: account?.id, // the Elowen account behind this turn (undefined = unlinked sender)
      elowenUsername: account?.username || account?.name,
      // Human platform permissions come only from the linked account. `access.admin` on an ordinary room
      // remains room metadata for trusted-channel composition; it must not mint admin-only tools.
      admin: src.platform === 'cron' || src.platform === 'subagent'
        ? src.access?.admin === true || account?.admin === true
        : account?.admin === true,
      owner: (account?.id !== undefined && this.isOwner(account.id)) || automationOwner,
      // The adapter's `direct` bit is only a claim. PlatformOrchestrator validates it against the verified
      // platform link and the durable session owner, then replaces this value for the admitted turn.
      conversation: 'shared',
    };
    // accountUserId includes host-authenticated automation (`actAsUserId`) for policy/memory scoping.
    // linkedUserId is narrower: only a real platform link may prove that an adapter's direct-chat claim
    // belongs to this sender.
    return { identity, sender, accountUserId: account?.id, linkedUserId: linked?.id };
  }

  /** Identity for host-authenticated automation replaying into a verified direct platform conversation. */
  forDirectChat(userId: number, platform: string, policy: Policy): TurnIdentity {
    const row = this.d.users.get(userId);
    return {
      platform,
      userId: String(userId),
      elowenUserId: userId,
      elowenUsername: row?.username || row?.name,
      admin: policy.allowedProjectIds === 'all',
      owner: this.isOwner(userId),
      conversation: 'direct',
    };
  }
}
