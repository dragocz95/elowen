// The people directory: who the bot may write to FIRST, and where.
//
// Teams proactive messaging cannot be addressed by e-mail or UPN — the Bot Connector only takes a
// `conversationId`. But every inbound activity and every conversation roster the bot already reads
// carries the pieces needed to build one: the `29:` channel account id, the Entra `aadObjectId`, a
// display name and (from the roster) a UPN/e-mail. So the directory is assembled from traffic the
// plugin already sees, and the 1:1 `conversationId` opened for a person is remembered next to them —
// the second message to someone never re-opens their chat.
//
// Persisted through the plugin's existing StateStore under one reserved entry, so this is not a second
// storage mechanism next to the per-conversation state. Identity fields only: no message text.

/** Reserved StateStore entry. A conversation id is always `a:…`/`19:…`, so this cannot collide. */
const DIR_KEY = '_people';

/** Directory cap. Entries are tiny, but a bot in a large tenant sees a lot of rosters — the oldest
 *  records are evicted rather than letting the state file grow without bound. */
const MAX_PEOPLE = 500;

const norm = (v) => (typeof v === 'string' ? v.trim() : '');
const lower = (v) => norm(v).toLowerCase();

/** The stable key for a person: their Entra object id when known — it survives a rename and a
 *  re-encoded channel id — else the channel account id. A display name is never a key. */
function personKey(person) {
  return lower(person?.aad) || lower(person?.id) || '';
}

/** One human-readable line per person, for tool output. Never carries anything but identity. */
export function personLine(person) {
  return [
    person.name ? `name: ${person.name}` : null,
    person.upn ? `upn: ${person.upn}` : null,
    person.aad ? `aadObjectId: ${person.aad}` : null,
    person.id ? `id: ${person.id}` : null,
    person.conv ? `chat: open (${person.conv})` : 'chat: not opened yet',
  ].filter(Boolean).join(' · ');
}

export class PeopleDirectory {
  constructor(state, logger = console) {
    this.state = state;
    this.log = logger;
  }

  /** Every known person as `{ key, … }` records. Keys whose value was cleared (eviction writes
   *  `undefined`, which JSON drops on the way to disk) are filtered out of the live cache too. */
  list() {
    const raw = this.state.get(DIR_KEY);
    const out = [];
    for (const [key, value] of Object.entries(raw ?? {})) {
      if (value && typeof value === 'object') out.push({ key, ...value });
    }
    return out;
  }

  /**
   * Record (or enrich) what we now know about a person. Every field is optional and merges over what
   * was stored before — a roster read knows the UPN, an inbound activity knows the conversation.
   *
   * Writes ONLY when something actually changed: this runs on every inbound message, and the state
   * file is rewritten atomically on each patch.
   */
  remember({ aadObjectId, id, name, upn, conversationId, serviceUrl } = {}) {
    const key = personKey({ aad: aadObjectId, id });
    if (!key) return null;
    const prior = this.state.get(DIR_KEY)?.[key] ?? {};
    // Fixed field order, so the change comparison below is a plain string compare.
    const merged = {
      aad: norm(aadObjectId) || norm(prior.aad),
      id: norm(id) || norm(prior.id),
      name: norm(name) || norm(prior.name),
      upn: norm(upn) || norm(prior.upn),
      conv: norm(conversationId) || norm(prior.conv),
      url: norm(serviceUrl) || norm(prior.url),
    };
    for (const field of Object.keys(merged)) if (!merged[field]) delete merged[field];
    const { at: _seen, ...priorFields } = prior;
    if (JSON.stringify(priorFields) === JSON.stringify(merged)) return { key, ...prior };
    const record = { ...merged, at: Date.now() };
    try {
      this.state.patch(DIR_KEY, { [key]: record, ...this.evictions(key) });
    } catch (e) {
      // The directory is an optimisation over what the bot can re-learn from the next roster read —
      // never a reason to fail the turn a user is waiting on.
      this.log?.warn?.(`msteams directory: could not persist ${key}: ${e?.message ?? e}`);
    }
    return { key, ...record };
  }

  /** Oldest-first eviction once the cap is exceeded, as a patch fragment (`key: undefined` clears). */
  evictions(keepKey) {
    const people = this.list().filter((p) => p.key !== keepKey);
    const over = people.length + 1 - MAX_PEOPLE;
    if (over <= 0) return {};
    const drop = {};
    for (const p of people.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0)).slice(0, over)) {
      drop[p.key] = undefined;
    }
    return drop;
  }

  /**
   * Resolve a target to exactly ONE person.
   *
   * `email` / `aadObjectId` / `userId` / `name` restrict matching to that field; `query` accepts any of
   * them (identifiers first, display name last). Returns `{ person }` on a unique hit,
   * `{ candidates }` when a name matches several people — an ambiguous name is REFUSED, never guessed —
   * and `{}` when nobody matches.
   */
  resolve(target = {}) {
    const people = this.list();
    const email = lower(target.email);
    const aad = lower(target.aadObjectId);
    const userId = lower(target.userId);
    const name = lower(target.name);
    const query = lower(target.query);

    if (email) return one(people.filter((p) => lower(p.upn) === email));
    if (aad) return one(people.filter((p) => lower(p.aad) === aad));
    if (userId) return one(people.filter((p) => lower(p.id) === userId));
    if (name) return this.byName(people, name);
    if (!query) return {};

    const byId = people.filter((p) => lower(p.upn) === query || lower(p.aad) === query || lower(p.id) === query);
    if (byId.length) return one(byId);
    return this.byName(people, query);
  }

  /** Name matching: an exact (case-insensitive) name wins outright; otherwise every substring hit is a
   *  candidate, and more than one candidate is an ambiguity for the caller to resolve. */
  byName(people, name) {
    const exact = people.filter((p) => lower(p.name) === name);
    if (exact.length) return one(exact);
    return one(people.filter((p) => lower(p.name).includes(name)));
  }
}

function one(matches) {
  if (matches.length === 1) return { person: matches[0] };
  if (matches.length > 1) return { candidates: matches };
  return {};
}
