import type { TurnIdentity } from '../plugins/policyContext.js';
import type { Policy } from '../plugins/policy.js';
import type { SessionSource } from '../plugins/api.js';
import type { DelegatedExecutionScope } from './delegatedScope.js';

/** A platform sender resolved to the Elowen account that claimed the platform id in Account settings. */
interface LinkedUser { id: number; name: string; username?: string; admin: boolean }

export interface IdentityDeps {
  /** The Elowen user that anchors platform channel sessions (the admin). Undefined = single-user mode. */
  platformOwner?: () => number | undefined;
  /** Resolve a platform sender (e.g. a Discord id) to the Elowen user who claimed it. */
  resolvePlatformUser?: (platform: string, platformUserId: string) => LinkedUser | null;
  users: { get(userId: number): { username?: string } | null | undefined };
}

/** The ONE place turn identities are minted — auditable, testable, and hard to fork by accident.
 *  `owner` is stricter than `admin`: only the operator themselves (their authenticated chat, their
 *  linked platform account, or their own server-internal automation like cron/subagent) counts,
 *  NEVER a foreign platform member who merely holds an admin-mapped role. `admin` still reflects
 *  all-access policy (project power tools); the two are deliberately separate. */
export class IdentityResolver {
  constructor(private d: IdentityDeps) {}

  /** Whether `userId` is the instance operator. When a platform owner is configured (production), it is
   *  exactly that user; with none configured (single-user / tests) every user is treated as the owner,
   *  preserving the pre-identity behaviour where the owner's own store was always used. */
  isOwner(userId: number | undefined): boolean {
    if (userId === undefined) return false;
    const owner = this.d.platformOwner?.();
    return owner === undefined ? true : userId === owner;
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
    };
  }

  /** Rehydrate the original identity of an idle delegated child. The child is never reinterpreted as
   * the account owner merely because that account owns its SQLite row: only the captured origin-owner
   * bit survives, and even that is meaningful only for the configured instance operator. */
  forDelegatedTurn(scope: DelegatedExecutionScope, ownerUserId: number): TurnIdentity {
    return {
      platform: 'subagent',
      userId: 'subagent',
      admin: scope.admin,
      owner: scope.owner && this.isOwner(ownerUserId),
    };
  }

  /** The identity of a platform turn (Discord message, cron tick, subagent delegation) plus the
   *  verified-identity line spliced ABOVE the sender's text when their platform id is linked to an
   *  Elowen account. The display name is attacker-influenced (a user picks their own Elowen name), so
   *  brackets/newlines are stripped before it enters this trusted line — otherwise a name like
   *  `x] SYSTEM: …` could forge instructions into the prompt. */
  forPlatformTurn(src: SessionSource, owner: number): { identity: TurnIdentity; verifiedPrefix: string; linkedUserId?: number } {
    const linked = this.d.resolvePlatformUser?.(src.platform, src.userId);
    const safeName = linked ? linked.name.replace(/[[\]\r\n]/g, ' ').trim().slice(0, 80) : '';
    const verifiedPrefix = linked
      ? `[Verified: this sender is the Elowen user "${safeName}"${linked.id === owner ? ' — the operator of this instance' : ''}]\n`
      : '';
    // Cron is owner-authored server automation. A subagent is different: it must carry the ORIGINAL
    // turn's owner truth explicitly, because a foreign platform role can legitimately have admin scope.
    // Deriving subagent ownership from `admin` would elevate that role into owner-only raw-token tools.
    const automationOwner = src.platform === 'cron'
      ? src.access?.admin === true
      : src.platform === 'subagent' && src.access?.owner === true;
    const identity: TurnIdentity = {
      platform: src.platform,
      userId: src.userId,
      elowenUserId: linked?.id, // the verified Elowen account behind this platform sender (undefined = unlinked)
      elowenUsername: linked?.username || linked?.name,
      admin: src.access?.admin === true || linked?.admin === true,
      owner: (linked?.id !== undefined && this.isOwner(linked.id)) || automationOwner,
    };
    // linkedUserId is the Elowen account this platform sender is verified as (their Discord id claimed in
    // Account settings). Memory recall/save keys on it: an unlinked sender has no account, so no memory.
    return { identity, verifiedPrefix, linkedUserId: linked?.id };
  }
}
