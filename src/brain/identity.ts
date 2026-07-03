import type { TurnIdentity } from '../plugins/policyContext.js';
import type { Policy } from '../plugins/policy.js';
import type { SessionSource } from '../plugins/api.js';

/** A platform sender resolved to the Orca account that claimed the platform id in Account settings. */
interface LinkedUser { id: number; name: string; username?: string; admin: boolean }

export interface IdentityDeps {
  /** The Orca user that anchors platform channel sessions (the admin). Undefined = single-user mode. */
  platformOwner?: () => number | undefined;
  /** Resolve a platform sender (e.g. a Discord id) to the Orca user who claimed it. */
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

  /** The identity of a user driving their OWN authenticated Orca chat (web dock / CLI). */
  forOwnerChat(userId: number, policy: Policy): TurnIdentity {
    return {
      platform: 'orca',
      userId: String(userId),
      orcaUsername: this.d.users.get(userId)?.username,
      admin: policy.allowedProjectIds === 'all',
      owner: this.isOwner(userId), // their own authenticated chat → operator
    };
  }

  /** The identity of a platform turn (Discord message, cron tick, subagent delegation) plus the
   *  verified-identity line spliced ABOVE the sender's text when their platform id is linked to an
   *  Orca account. The display name is attacker-influenced (a user picks their own Orca name), so
   *  brackets/newlines are stripped before it enters this trusted line — otherwise a name like
   *  `x] SYSTEM: …` could forge instructions into the prompt. */
  forPlatformTurn(src: SessionSource, owner: number): { identity: TurnIdentity; verifiedPrefix: string } {
    const linked = this.d.resolvePlatformUser?.(src.platform, src.userId);
    const safeName = linked ? linked.name.replace(/[[\]\r\n]/g, ' ').trim().slice(0, 80) : '';
    const verifiedPrefix = linked
      ? `[Verified: this sender is the Orca user "${safeName}"${linked.id === owner ? ' — the operator of this instance' : ''}]\n`
      : '';
    // Owner-authored server-internal automation (cron/subagent) runs as the operator; a foreign
    // platform member never does, regardless of admin-mapped roles.
    const internalAutomation = src.platform === 'cron' || src.platform === 'subagent';
    const identity: TurnIdentity = {
      platform: src.platform,
      userId: src.userId,
      orcaUsername: linked?.username || linked?.name,
      admin: src.access?.admin === true || linked?.admin === true,
      owner: (linked?.id !== undefined && this.isOwner(linked.id)) || (internalAutomation && src.access?.admin === true),
    };
    return { identity, verifiedPrefix };
  }
}
