// Runtime-context plugin: tells the model what "now" is and WHO it is talking to. Registers per-turn
// context providers (NOT system-prompt fragments), so both stay fresh every turn while the cached prompt
// prefix stays stable — no cache invalidation. Zero dependencies.
const DAYPARTS = [[5, 'early morning'], [9, 'morning'], [12, 'midday'], [17, 'afternoon'], [21, 'evening']];
const daypart = (h) => (DAYPARTS.find(([end]) => h < end)?.[1]) ?? 'night';

/** What each conversation kind means for anything the turn creates on someone's behalf. */
const SURFACES = {
  own: 'their own Elowen chat',
  direct: 'a direct 1:1 chat — nobody else can read it',
  shared: 'a shared room other people can read, so the sender changes from message to message',
  delegated: 'a delegated sub-agent run, which has no conversation of its own',
};

/** A display name is chosen by the user, so it is attacker-influenced. Strip the bracket/newline shapes
 *  that could forge an extra line into this trusted block — the same guard the verified-sender prefix
 *  uses — and bound the length. */
const safe = (value) => String(value ?? '').replace(/[[\]\r\n]/g, ' ').trim().slice(0, 80);

export function register(ctx) {
  // `ctx.timezone()` resolves THIS plugin's configured zone (the operator sets it right here, in Settings)
  // and is the same value the cron scheduler reads — so "what time is it for this user" is answered once,
  // in one place, and a schedule and the injected clock can never disagree. Read per turn, so changing the
  // setting applies immediately.
  ctx.registerTurnContext(() => {
    const timezone = ctx.timezone();
    // Format in that zone via Intl (no deps). new Date() is the wall clock at turn time.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).reduce((a, p) => ((a[p.type] = p.value), a), {});
    const hour = Number(parts.hour);
    return `Current date & time: ${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${timezone}, ${daypart(hour)}).`;
  });

  // WHO is on the other side, and what kind of place this is. Without it the model cannot tell a private
  // chat from a shared room, so anything it creates "for you" is a guess — and it guessed wrong: a job
  // scheduled from a personal chat was filed instance-wide, where it reported to nobody. Separate provider
  // from the clock above so each stays one readable line.
  ctx.registerTurnContext(() => {
    const id = ctx.currentIdentity();
    if (!id) return '';
    const account = id.elowenUserId != null
      ? `${safe(id.elowenUsername) || `account #${id.elowenUserId}`} (Elowen account #${id.elowenUserId}${id.owner ? ', the operator of this instance' : ''})`
      // No account behind the turn: nothing may be filed as "theirs", because there is no owner to file it under.
      : `an unverified sender with no linked Elowen account`;
    const where = SURFACES[id.conversation] ?? 'an unrecognised surface';
    return `You are speaking with ${account}, on ${safe(id.platform) || 'an unknown platform'}, in ${where}.`;
  });

  ctx.logger.info(`runtime-context active (${ctx.timezone()})`);
}
