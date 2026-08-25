import { describe, it, expect } from 'vitest';
import { defaultUserSessionId, freshUserSessionId, channelSessionId, archivedChannelSessionId, isNonUserSession, isChannelSession, isSubagentSession, isArchivedChannelSession, channelIdOf, platformOfSession, isOwnedUserSession, mayDeliverToSession, contributionOwnerForSession, resolvesContributionsPerTurn } from '../../src/brain/sessionId.js';

describe('brain session id conventions', () => {
  it('builds the user and channel id shapes', () => {
    expect(defaultUserSessionId(7)).toBe('brain-7');
    expect(freshUserSessionId(7)).toMatch(/^brain-7-[a-z0-9]+$/);
    expect(channelSessionId('discord-123')).toBe('brain-ch-discord-123');
  });

  it('classifies channel sessions as non-user (excluded from list/resume/delete)', () => {
    expect(isNonUserSession(channelSessionId('x'))).toBe(true);
    expect(isNonUserSession(defaultUserSessionId(1))).toBe(false);
    expect(isNonUserSession('brain-1-abc123')).toBe(false);
  });

  it('classifies channel and subagent sessions and recovers the channel id', () => {
    expect(isChannelSession(channelSessionId('discord-1'))).toBe(true);
    // A subagent session is a channel sub-family.
    expect(isSubagentSession('brain-ch-subagent-abc')).toBe(true);
    expect(isChannelSession('brain-ch-subagent-abc')).toBe(true);
    expect(isSubagentSession(channelSessionId('discord-1'))).toBe(false);
    expect(isArchivedChannelSession(archivedChannelSessionId('discord-1'))).toBe(true);
    expect(isArchivedChannelSession(channelSessionId('discord-1'))).toBe(false);
    expect(channelIdOf('brain-ch-subagent-abc')).toBe('subagent-abc');
    expect(channelIdOf(channelSessionId('discord-1'))).toBe('discord-1');
  });

  // A personal skill is a briefing its owner asked for. A shared room serves whoever writes next, so it
  // has no session-wide owner at all and resolves the WRITER of the turn in flight; a sub-agent serves
  // exactly one turn, so it keeps whoever delegated it.
  it('contributionOwnerForSession: own conversations keep the owner, a shared room follows the writer', () => {
    expect(contributionOwnerForSession(defaultUserSessionId(7), 7)).toBe(7);
    // A sub-agent inherits from the turn that delegated it: the row owner out of an owner conversation
    // (they are the same person), and out of a room the writer its caller read off the parent's live
    // record — never the row owner there, who is only whoever opened the room.
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7, { parentSessionId: defaultUserSessionId(7) })).toBe(7);
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7, { parentSessionId: channelSessionId('discord-1') })).toBe(null);
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7, { parentSessionId: channelSessionId('discord-1'), writerUserId: 9 })).toBe(9);
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7, { parentSessionId: 'brain-ch-subagent-parent' })).toBe(null);
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7)).toBe(null);
    // The room itself: the verified writer, and the row owner NEVER.
    expect(contributionOwnerForSession(channelSessionId('discord-1'), 7)).toBe(null);
    expect(contributionOwnerForSession(channelSessionId('discord-1'), 7, { writerUserId: 9 })).toBe(9);
    // No account behind the turn (an unlinked sender, a cron job, instance automation) → the instance set.
    expect(contributionOwnerForSession(channelSessionId('cron-job-4'), 7, { writerUserId: null })).toBe(null);
    expect(contributionOwnerForSession(defaultUserSessionId(7), null)).toBe(null);
    expect(contributionOwnerForSession(defaultUserSessionId(7), undefined)).toBe(null);
  });

  // A 1:1 platform chat carries a `brain-ch-*` id like a shared room does, but only one person can ever
  // write in it — so the reason the blanket rule exists (the sender changes from turn to turn) does not
  // apply, and the owner's personal skills may load.
  it('contributionOwnerForSession: a DIRECT platform chat keeps its owner, a shared room still does not', () => {
    const dm = channelSessionId('msteams-personal-1');
    expect(contributionOwnerForSession(dm, 7, { direct: true })).toBe(7);
    expect(contributionOwnerForSession(dm, 7, { direct: false })).toBe(null);
    expect(contributionOwnerForSession(dm, 7)).toBe(null); // fail-closed: unmarked reads as shared
    // Being direct never invents an owner where the turn has no account.
    expect(contributionOwnerForSession(dm, null, { direct: true })).toBe(null);
    // A sub-agent is deliberately NOT widened: proving its parent is direct needs that parent's row.
    expect(contributionOwnerForSession('brain-ch-subagent-abc', 7, { parentSessionId: channelSessionId('msteams-personal-1'), direct: true })).toBe(null);
  });

  // Which surface must announce its skills with every turn rather than once in its cached system prompt —
  // exactly the one that has no session-wide contribution owner above.
  it('resolvesContributionsPerTurn: a shared room, and only a shared room', () => {
    expect(resolvesContributionsPerTurn(channelSessionId('discord-1'), false)).toBe(true);
    expect(resolvesContributionsPerTurn(channelSessionId('cron-job-4'), false)).toBe(true);
    expect(resolvesContributionsPerTurn(channelSessionId('msteams-personal-1'), true)).toBe(false);
    expect(resolvesContributionsPerTurn('brain-ch-subagent-abc', false)).toBe(false);
    expect(resolvesContributionsPerTurn(defaultUserSessionId(7), false)).toBe(false);
  });

  // Delivering INTO a conversation and MANAGING it are different rights, so the two predicates differ on
  // exactly one case: the direct chat. Keeping both assertions together is what stops them drifting back
  // into one rule — which would either hide a DM from its own scheduled job, or expose it to the web list.
  it('mayDeliverToSession accepts a direct chat that isOwnedUserSession still refuses', () => {
    const dm = channelSessionId('msteams-personal-1');
    const room = channelSessionId('discord-1');
    const own = defaultUserSessionId(7);

    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 7, dm)).toBe(true);
    expect(isOwnedUserSession({ user_id: 7 }, 7, dm)).toBe(false); // …yet stays out of the web list

    expect(mayDeliverToSession({ user_id: 7, direct: 0 }, 7, room)).toBe(false); // shared room: never
    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 8, dm)).toBe(false); // someone else's DM
    expect(mayDeliverToSession(undefined, 7, dm)).toBe(false); // no row
    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 7, 'brain-ch-subagent-job')).toBe(false); // delegated
    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 7, archivedChannelSessionId('msteams-personal-1'))).toBe(false); // archive
    expect(mayDeliverToSession({ user_id: 7, direct: 0 }, 7, own)).toBe(true); // an ordinary conversation is unaffected
  });

  // The register tells a Teams room from a web chat with this, and the ONLY record of where a conversation
  // came from is its id — so the real id shapes have to survive the split, including a Teams conversation
  // id that is itself full of punctuation and an archived transcript's random tail.
  it('platformOfSession reads the platform back out of a channel id', () => {
    expect(platformOfSession(channelSessionId('msteams-a:1uAUssTAR-rJYOk6#4'))).toBe('msteams');
    expect(platformOfSession(channelSessionId('msteams-19:defb1085@thread.tacv2;messageid=1787559885863#0'))).toBe('msteams');
    expect(platformOfSession(archivedChannelSessionId('msteams-a:1uAUss#4'))).toBe('msteams');
    expect(platformOfSession(channelSessionId('discord-123'))).toBe('discord');
    expect(platformOfSession('brain-ch-subagent-sub-dlg-c06bc20d')).toBe('subagent');
    // Not a channel at all: an ordinary conversation has no platform to report.
    expect(platformOfSession(defaultUserSessionId(7))).toBeNull();
    expect(platformOfSession(freshUserSessionId(7))).toBeNull();
    // A channel id with nothing after the platform is malformed; claiming a platform anyway would invent one.
    expect(platformOfSession(channelSessionId('discord'))).toBeNull();
  });

  it('isOwnedUserSession: owner AND a real conversation AND the row exists (and narrows the row type)', () => {
    const id = defaultUserSessionId(7);
    expect(isOwnedUserSession({ user_id: 7, title: 'x' }, 7, id)).toBe(true);
    expect(isOwnedUserSession({ user_id: 9 }, 7, id)).toBe(false); // not the owner
    expect(isOwnedUserSession(undefined, 7, id)).toBe(false); // no row
    expect(isOwnedUserSession({ user_id: 7 }, 7, channelSessionId('c'))).toBe(false); // channel session
    // Narrows: after the guard, the row's own fields are accessible.
    const row: { user_id: number; title: string } | undefined = { user_id: 7, title: 'kept' };
    expect(isOwnedUserSession(row, 7, id) ? row.title : null).toBe('kept');
  });
});
