/** One-shot tickets for the plugin WebSocket surface.
 *
 *  A browser opening `wss://…/ws/plugins/<plugin>/<path>` reaches the daemon DIRECTLY through nginx's
 *  `/ws/` location — it never passes the web BFF, so it carries no bearer token and the daemon's normal
 *  auth middleware cannot run. The plugin therefore mints a ticket from an ALREADY authenticated request
 *  (its own `/plugins/<plugin>/api/…` route) and the page presents that ticket in the upgrade URL instead.
 *
 *  In memory on purpose: a WebSocket does not survive a daemon restart, so a ticket that outlived one
 *  would only ever redeem onto a connection that cannot exist. Persisting it would add a credential at
 *  rest and buy nothing.
 *
 *  Bounded and self-sweeping, with NO timer: expired entries are dropped on the next `issue`, and the map
 *  is capped so a plugin looping on `issue` cannot grow the daemon's heap. Nothing here needs an owner to
 *  shut down, which is exactly why there is no interval to leak. */

import { randomBytes } from 'node:crypto';

/** What a redeemed ticket proves. `userId` is the account the ticket was minted FOR — the dispatcher
 *  resolves the admin flag and project scope from it at redeem time, so a stale ticket can never carry a
 *  stale authorisation. */
export interface WebSocketTicket {
  /** The plugin that issued it. A ticket is valid only on ITS OWN plugin's routes. */
  plugin: string;
  /** Elowen account id, or null in open (userless) mode. */
  userId: number | null;
  /** Opaque plugin-owned context handed back to the handler (e.g. which VNC session to attach to). */
  payload: unknown;
  /** Epoch ms after which the ticket is dead. */
  expiresAt: number;
}

/** Short by design: the page redeems the ticket immediately after fetching it. */
const DEFAULT_TTL_MS = 30_000;
/** Hard ceiling — a longer-lived ticket is a bearer credential sitting in a URL. */
const MAX_TTL_MS = 5 * 60_000;
/** Cap on outstanding tickets; the oldest is evicted first (it is also the closest to expiring). */
const MAX_TICKETS = 1000;

export class WebSocketTicketStore {
  /** Insertion-ordered, which is what makes "evict the oldest" a single `keys().next()`. */
  private readonly tickets = new Map<string, WebSocketTicket>();

  /** Mint a ticket. `ttlMs` is clamped to [0, {@link MAX_TTL_MS}]; 0 yields an already-dead ticket rather
   *  than silently substituting the default, so a plugin that computes a bad TTL fails closed. */
  issue(input: { plugin: string; userId: number | null; payload?: unknown; ttlMs?: number }): { ticket: string; expiresAt: number } {
    const now = Date.now();
    // Sweep before measuring: the cap must evict LIVE tickets only, or a burst of expired ones would
    // push out the fresh ticket somebody is about to redeem.
    for (const [key, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(key);
    }
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next();
      if (oldest.done) break;
      this.tickets.delete(oldest.value);
    }
    const ttl = Math.min(Math.max(input.ttlMs ?? DEFAULT_TTL_MS, 0), MAX_TTL_MS);
    const expiresAt = now + ttl;
    // 256 bits of entropy, URL-safe: it travels as a query parameter.
    const ticket = randomBytes(32).toString('base64url');
    this.tickets.set(ticket, { plugin: input.plugin, userId: input.userId, payload: input.payload, expiresAt });
    return { ticket, expiresAt };
  }

  /** Consume a ticket. The entry is removed by the ATTEMPT, not by its success: a ticket that turns out
   *  to be expired, or that is presented on the wrong plugin's route, is spent all the same. Otherwise a
   *  ticket leaked into a log or a referrer could be retried until it happened to line up. */
  redeem(ticket: string): WebSocketTicket | undefined {
    const entry = this.tickets.get(ticket);
    if (entry === undefined) return undefined;
    this.tickets.delete(ticket);
    if (entry.expiresAt <= Date.now()) return undefined;
    return entry;
  }

  /** Outstanding tickets, including ones that have expired but not yet been swept. Tests and diagnostics. */
  get size(): number {
    return this.tickets.size;
  }
}

/** The daemon's single ticket store. Process-wide because the two ends live far apart: a plugin mints
 *  through its `PluginContext` (built by the plugin registry) and the API layer's upgrade handler
 *  redeems, and threading one instance between them would mean another positional argument on the
 *  registry's already enormous `contextFor`. Tickets are per-process state either way. */
export const webSocketTickets = new WebSocketTicketStore();
