// The guild's text-capable destinations, for the cron-job channel picker in Settings.
//
// This is Discord's own surface: it reads this plugin's bot token and guild id and talks to the
// Discord REST API. The token never leaves (or logs from) the daemon — only ids and names come back.
// A missing config or an upstream failure degrades to an empty list, never a leaked error detail:
// the picker's job is to offer what it can, and a network hiccup is not the operator's problem to read.

/** Text channel (Discord type 0) and public/private thread (11/12) — nothing else can receive a post. */
const TEXT_CHANNEL = 0;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
/** Forum (15) and media (16) parents: their "threads" are posts, not destinations for a cron echo. */
const FORUM = 15;
const MEDIA = 16;

/** Cached briefly: the picker refetches per detail view and Discord rate-limits the guild routes. */
const CACHE_MS = 60_000;
let cache = null;

export function resetChannelCache() { cache = null; }

export async function listGuildChannels(config) {
  const token = typeof config.botToken === 'string' ? config.botToken : '';
  const guildId = typeof config.guildId === 'string' ? config.guildId.trim() : '';
  if (!token || !guildId) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  try {
    const headers = { authorization: `Bot ${token}` };
    const base = `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`;
    const [chRes, thRes] = await Promise.all([
      fetch(`${base}/channels`, { headers }),
      fetch(`${base}/threads/active`, { headers }),
    ]);
    if (!chRes.ok) return [];
    const channels = await chRes.json();
    const nameById = new Map(channels.map((ch) => [ch.id, ch.name]));
    const typeById = new Map(channels.map((ch) => [ch.id, ch.type]));
    const out = channels
      .filter((ch) => ch.type === TEXT_CHANNEL)
      .map((ch) => ({ id: ch.id, name: ch.name, type: 'channel' }));
    if (thRes.ok) {
      const { threads } = await thRes.json();
      for (const th of threads ?? []) {
        if (th.type !== PUBLIC_THREAD && th.type !== PRIVATE_THREAD) continue;
        const parentType = typeById.get(th.parent_id ?? '');
        if (parentType === FORUM || parentType === MEDIA) continue;
        out.push({ id: th.id, name: th.name, type: 'thread', parentName: nameById.get(th.parent_id ?? '') });
      }
    }
    cache = { at: Date.now(), data: out };
    return out;
  } catch {
    return []; // network failure → empty picker, never a leaked error detail
  }
}
