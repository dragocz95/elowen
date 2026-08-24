/** How a chat platform's sender identity maps onto an Elowen account — as DATA, in one place.
 *
 *  Every platform used to spell this out four or five times over: a `CliSettings` field, a validation
 *  regex in the setting store, a normalisation expression in `resolvePlatformUser`, a partial UNIQUE
 *  index, a conflict error class, an account-view input and a handful of surface unions. Telegram is
 *  what that duplication costs: core supported `telegramUserId` end to end, but the account view had no
 *  field for it, so nobody could ever link a Telegram sender and every Telegram turn was dropped
 *  unattributed. A descriptor set collapses all of it, and adding the next platform is one entry here
 *  plus whatever the compiler then demands.
 *
 *  DELIBERATELY CORE DATA, NOT A PLUGIN MANIFEST CONTRIBUTION.
 *  - `resolvePlatformUser` decides WHO a sender is. Letting a manifest supply the matching rule would
 *    let one plugin claim another's `linkSettingKey`, or normalise two distinct senders onto one stored
 *    value and silently merge two people into one account. The partial UNIQUE index is no backstop
 *    there: it constrains WRITES, while impersonation happens on the READ path.
 *  - The set must exist before any plugin is loaded — the partial unique indexes are created when the
 *    database is opened, and `SlashSurface` / `ActivitySurface` are compile-time unions.
 *  - A link must survive its plugin being disabled or uninstalled. Keying identity on the installed
 *    plugin set would silently unlink whoever linked a platform the operator later toggled off.
 */

/** A platform that may bind a sender to an account WITHOUT a pre-existing explicit link.
 *
 *  This is an authentication-grade claim, so it is only ever honoured for a platform whose adapter
 *  authenticates the sender itself and whose evidence the CORE — not the adapter — decides to trust:
 *  Microsoft Teams alone, because the Bot Framework validates the inbound activity's JWT and the UPN
 *  rides on that validated identity. Discord, WhatsApp and Telegram report a sender id and nothing a
 *  third party has vouched for, so they carry no bootstrap and must be linked explicitly.
 *
 *  Structurally it cannot fire where it was not earned either: `verifiedEmailUnique` only ever runs on
 *  an e-mail the CALLER passed in as platform-verified, and the only caller that passes one is the
 *  Teams identity path. A descriptor asserting it for a platform whose adapter has no verified e-mail
 *  to hand over simply never reaches the branch.
 */
export interface PlatformIdentityBootstrap {
  /** Bind the sender to the single account holding this platform-verified e-mail, then persist the
   *  link so it survives a later e-mail change. Never fires on absent, unverified or duplicate mail. */
  readonly verifiedEmailUnique: boolean;
  /** `external_identities.provider` whose OAuth binding also resolves this sender — the durable link a
   *  sign-in established, which must win before any e-mail evidence is consulted. */
  readonly externalProvider: string;
}

export interface PlatformIdentityDescriptor {
  /** Adapter platform id. Doubles as the plugin name and the chat/activity surface name. */
  readonly platform: PlatformSurface;
  /** `user_settings.key` holding the link, and the `CliSettings` field name exposed to the account UI. */
  readonly linkSettingKey: string;
  /** Name of the partial UNIQUE index guarding `linkSettingKey`. Pinned per platform because these
   *  indexes already exist on live databases — deriving a new name would silently leave the old index
   *  in place and the real one uncreated, which is a data migration nobody asked for. */
  readonly indexName: string;
  /** Sender id (or user-typed value) → the stored form. Used in BOTH directions, so a value a user
   *  types and the id the adapter reports for the same person must normalise to the same string. */
  readonly normalize: (raw: string) => string;
  /** Whether a NORMALIZED value is a plausible identity for this platform. A value failing it clears
   *  the link rather than storing garbage. Deliberately NOT applied on the resolve path: a row already
   *  in the database was validated when it was written, and re-judging it later would unlink people
   *  whenever the shape is tightened. */
  readonly validate: (value: string) => boolean;
  /** Czech 409 copy when another account already holds this identity. */
  readonly conflictMessage: string;
  readonly bootstrap?: PlatformIdentityBootstrap;
}

import type { PlatformSurface } from './wireContract.js';

const digits = (raw: string): string => raw.replace(/[^\d]/g, '');

/** Order is meaningful: it is the order surfaces are listed in and the order the account view renders
 *  its link fields in. */
export const PLATFORM_IDENTITIES = [
  {
    platform: 'discord',
    linkSettingKey: 'discordUserId',
    indexName: 'idx_user_settings_discord_id',
    normalize: (raw: string) => raw.trim(),
    validate: (value: string) => /^\d{5,25}$/.test(value),
    conflictMessage: 'Toto Discord ID už má propojené jiný uživatel.',
  },
  {
    platform: 'msteams',
    linkSettingKey: 'msteamsUserId',
    indexName: 'idx_user_settings_msteams_id',
    // The adapter reports `from.aadObjectId || from.id`, so BOTH shapes are accepted: an Entra object
    // id (GUID) and a Teams user id (`29:…`). Lower-cased because Entra returns a GUID in either case
    // and the partial UNIQUE index compares bytes — otherwise one person could claim two rows.
    normalize: (raw: string) => raw.trim().toLowerCase(),
    validate: (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) || /^29:[\w-]{10,250}$/.test(value),
    conflictMessage: 'Tuto identitu Microsoft Teams už má propojenou jiný uživatel.',
    bootstrap: { verifiedEmailUnique: true, externalProvider: 'msteams' },
  },
  {
    platform: 'telegram',
    linkSettingKey: 'telegramUserId',
    indexName: 'idx_user_settings_telegram_id',
    normalize: digits,
    validate: (value: string) => /^\d{5,25}$/.test(value),
    conflictMessage: 'Toto Telegram ID už má propojené jiný uživatel.',
  },
  {
    platform: 'whatsapp',
    linkSettingKey: 'whatsappNumber',
    indexName: 'idx_user_settings_whatsapp_number',
    // A sender arrives as a JID (`420778433908@s.whatsapp.net`, sometimes with a `:device` part); a
    // user types a phone number. Dropping everything from the first `@`/`:` and then every non-digit
    // maps both onto the same international-form number.
    normalize: (raw: string) => digits(raw.replace(/[@:].*$/, '')),
    validate: (value: string) => /^\d{6,15}$/.test(value),
    conflictMessage: 'Toto WhatsApp číslo už má propojené jiný uživatel.',
  },
] as const satisfies readonly PlatformIdentityDescriptor[];

/** Re-exported so consumers take the platform set and its descriptors from ONE module. Not every
 *  surface is a platform — the CLI, the web chat, cron and delegated runs have no platform identity —
 *  so surface unions ADD to this rather than replacing it. */
export type { PlatformSurface };
/** The `CliSettings` / `user_settings` keys that hold a platform link. */
export type PlatformLinkKey = (typeof PLATFORM_IDENTITIES)[number]['linkSettingKey'];

export const PLATFORM_SURFACES: readonly PlatformSurface[] = PLATFORM_IDENTITIES.map((d) => d.platform);
export const PLATFORM_LINK_KEYS: readonly PlatformLinkKey[] = PLATFORM_IDENTITIES.map((d) => d.linkSettingKey);

/** The descriptor for a platform id, or undefined for a platform with no identity model — an unknown
 *  platform must resolve to NOBODY rather than to a best guess. */
export function platformIdentity(platform: string): PlatformIdentityDescriptor | undefined {
  return PLATFORM_IDENTITIES.find((d) => d.platform === platform);
}

/** Invariants the whole design rests on, checked once at import so a bad edit fails at startup instead
 *  of at the moment somebody's identity is resolved:
 *  - one descriptor per platform, per setting key and per index name, so no platform can shadow
 *    another's link rows or silently share its uniqueness guarantee;
 *  - key and index names are plain identifiers, because `db.ts` interpolates them into DDL. */
function assertDescriptors(): void {
  const seen = new Map<string, string>();
  for (const d of PLATFORM_IDENTITIES) {
    for (const [what, value] of [['platform', d.platform], ['link key', d.linkSettingKey], ['index', d.indexName]] as const) {
      const owner = seen.get(`${what}:${value}`);
      if (owner) throw new Error(`platform identity: ${what} '${value}' is claimed by both ${owner} and ${d.platform}`);
      seen.set(`${what}:${value}`, d.platform);
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(d.linkSettingKey) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(d.indexName)) {
      throw new Error(`platform identity: ${d.platform} has a non-identifier setting key or index name`);
    }
  }
}
assertDescriptors();
