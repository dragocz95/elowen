// Runtime-context plugin: tells the model what "now" is. Registers a per-turn context provider (NOT a
// system-prompt fragment), so the timestamp is fresh every turn while the cached prompt prefix stays
// stable — no cache invalidation. Zero dependencies.
const DAYPARTS = [[5, 'early morning'], [9, 'morning'], [12, 'midday'], [17, 'afternoon'], [21, 'evening']];
const daypart = (h) => (DAYPARTS.find(([end]) => h < end)?.[1]) ?? 'night';

export function register(ctx) {
  const timezone = (typeof ctx.config.timezone === 'string' && ctx.config.timezone.trim()) || 'Europe/Prague';

  ctx.registerTurnContext(() => {
    // Format in the configured timezone via Intl (no deps). new Date() is the wall clock at turn time.
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});
    const hour = Number(parts.hour);
    return `Current date & time: ${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${timezone}, ${daypart(hour)}).`;
  });

  ctx.logger.info(`runtime-context active (${timezone})`);
}
