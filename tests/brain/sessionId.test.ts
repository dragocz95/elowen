import { describe, it, expect } from 'vitest';
import { defaultUserSessionId, freshUserSessionId, channelSessionId, taskSessionId, isNonUserSession, isChannelSession, isTaskSession, isSubagentSession, channelIdOf, isOwnedUserSession, mayDeliverToSession, skillOwnerForSession } from '../../src/brain/sessionId.js';

describe('brain session id conventions', () => {
  it('builds the four id shapes', () => {
    expect(defaultUserSessionId(7)).toBe('brain-7');
    expect(freshUserSessionId(7)).toMatch(/^brain-7-[a-z0-9]+$/);
    expect(channelSessionId('discord-123')).toBe('brain-ch-discord-123');
    expect(taskSessionId('t42')).toBe('brain-task-t42');
  });

  it('classifies channel/task sessions as non-user (excluded from list/resume/delete)', () => {
    expect(isNonUserSession(channelSessionId('x'))).toBe(true);
    expect(isNonUserSession(taskSessionId('x'))).toBe(true);
    expect(isNonUserSession(defaultUserSessionId(1))).toBe(false);
    expect(isNonUserSession('brain-1-abc123')).toBe(false);
  });

  it('classifies channel / task / subagent sessions and recovers the channel id', () => {
    expect(isChannelSession(channelSessionId('discord-1'))).toBe(true);
    expect(isChannelSession(taskSessionId('t1'))).toBe(false);
    expect(isTaskSession(taskSessionId('t1'))).toBe(true);
    // A subagent session is a channel sub-family.
    expect(isSubagentSession('brain-ch-subagent-abc')).toBe(true);
    expect(isChannelSession('brain-ch-subagent-abc')).toBe(true);
    expect(isSubagentSession(channelSessionId('discord-1'))).toBe(false);
    expect(channelIdOf('brain-ch-subagent-abc')).toBe('subagent-abc');
    expect(channelIdOf(channelSessionId('discord-1'))).toBe('discord-1');
  });

  // A personal skill is a briefing its owner asked for. A shared channel serves whoever writes next, so
  // it may only ever load the instance-wide set; a sub-agent serves exactly one owner, so it keeps his.
  it('skillOwnerForSession: own conversations and sub-agents keep the owner, a shared channel does not', () => {
    expect(skillOwnerForSession(defaultUserSessionId(7), 7)).toBe(7);
    expect(skillOwnerForSession(taskSessionId('t1'), 7)).toBe(7);
    // A sub-agent inherits from the turn that delegated it: yes out of an owner conversation, never out
    // of a shared channel (there the row owner is the operator, not the person who asked).
    expect(skillOwnerForSession('brain-ch-subagent-abc', 7, defaultUserSessionId(7))).toBe(7);
    expect(skillOwnerForSession('brain-ch-subagent-abc', 7, channelSessionId('discord-1'))).toBe(null);
    expect(skillOwnerForSession('brain-ch-subagent-abc', 7, 'brain-ch-subagent-parent')).toBe(null);
    expect(skillOwnerForSession('brain-ch-subagent-abc', 7)).toBe(null);
    expect(skillOwnerForSession(channelSessionId('discord-1'), 7)).toBe(null);
    // No account behind the turn (an unlinked sender, a cron job) → the instance set.
    expect(skillOwnerForSession(defaultUserSessionId(7), null)).toBe(null);
    expect(skillOwnerForSession(defaultUserSessionId(7), undefined)).toBe(null);
  });

  // A 1:1 platform chat carries a `brain-ch-*` id like a shared room does, but only one person can ever
  // write in it — so the reason the blanket rule exists (the sender changes from turn to turn) does not
  // apply, and the owner's personal skills may load.
  it('skillOwnerForSession: a DIRECT platform chat keeps its owner, a shared room still does not', () => {
    const dm = channelSessionId('msteams-personal-1');
    expect(skillOwnerForSession(dm, 7, undefined, true)).toBe(7);
    expect(skillOwnerForSession(dm, 7, undefined, false)).toBe(null);
    expect(skillOwnerForSession(dm, 7)).toBe(null); // fail-closed: unmarked reads as shared
    // Being direct never invents an owner where the turn has no account.
    expect(skillOwnerForSession(dm, null, undefined, true)).toBe(null);
    // A sub-agent is deliberately NOT widened: proving its parent is direct needs that parent's row.
    expect(skillOwnerForSession('brain-ch-subagent-abc', 7, channelSessionId('msteams-personal-1'), true)).toBe(null);
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
    expect(mayDeliverToSession({ user_id: 7 }, 7, room)).toBe(false); // fail-closed without the flag
    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 8, dm)).toBe(false); // someone else's DM
    expect(mayDeliverToSession(undefined, 7, dm)).toBe(false); // no row
    expect(mayDeliverToSession({ user_id: 7, direct: 1 }, 7, taskSessionId('t1'))).toBe(false); // task session
    expect(mayDeliverToSession({ user_id: 7 }, 7, own)).toBe(true); // an ordinary conversation is unaffected
  });

  it('isOwnedUserSession: owner AND a real conversation AND the row exists (and narrows the row type)', () => {
    const id = defaultUserSessionId(7);
    expect(isOwnedUserSession({ user_id: 7, title: 'x' }, 7, id)).toBe(true);
    expect(isOwnedUserSession({ user_id: 9 }, 7, id)).toBe(false); // not the owner
    expect(isOwnedUserSession(undefined, 7, id)).toBe(false); // no row
    expect(isOwnedUserSession({ user_id: 7 }, 7, channelSessionId('c'))).toBe(false); // channel session
    expect(isOwnedUserSession({ user_id: 7 }, 7, taskSessionId('t'))).toBe(false); // task session
    // Narrows: after the guard, the row's own fields are accessible.
    const row: { user_id: number; title: string } | undefined = { user_id: 7, title: 'kept' };
    expect(isOwnedUserSession(row, 7, id) ? row.title : null).toBe('kept');
  });
});
