import type { BrainCard, BrainCardItem } from './events.js';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);
// Bounds enforced at the emit boundary so an oversized card can't flood a client (the CLI renders a
// pinned card into the FIXED bottom stack — an uncapped body/list would overrun the terminal height).
const MAX_ITEMS = 50;
const MAX_TEXT = 200;
const MAX_TITLE = 120;
const MAX_BODY = 2000;

/** Coerce an untrusted `ctx.emitCard` payload into a clean, bounded BrainCard — items with empty text
 *  are dropped, an unknown status falls back to `pending`, and text/title/body/item-count are capped.
 *  Returns null when the input isn't a usable card (no id). A card with neither items nor body is a
 *  REMOVE signal (kept as-is so the registry clears it). */
export function normalizeCard(raw: unknown): BrainCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? '').trim();
  if (!id) return null;
  const items: BrainCardItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    if (items.length >= MAX_ITEMS) break;
    if (!it || typeof it !== 'object') continue;
    const text = String((it as Record<string, unknown>).text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const status = (it as Record<string, unknown>).status;
    items.push({ text, status: STATUSES.has(status as string) ? (status as BrainCardItem['status']) : 'pending' });
  }
  const body = typeof o.body === 'string' && o.body.trim() ? o.body.slice(0, MAX_BODY) : undefined;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.slice(0, MAX_TITLE) : undefined;
  return { id, title, items: items.length ? items : undefined, body, pinned: o.pinned === true };
}

/** Whether a normalized card carries no content — the signal to remove it from the panel. */
export function isEmptyCard(c: BrainCard): boolean {
  return (!c.items || c.items.length === 0) && !c.body;
}

/** The live set of display cards per conversation (keyed by card id). One instance is owned by
 *  BrainService; a client seeds from it on connect (via /brain/status) and then keeps it current from
 *  the `card` event stream — so a card survives an SSE reconnect / page refresh within the daemon's life.
 *  Mirrors ElicitationRegistry's role for parked questions. */
export class CardRegistry {
  private readonly bySession = new Map<string, Map<string, BrainCard>>();

  /** Upsert (or, for an empty card, remove) a card and return the normalized value to broadcast, or null
   *  when the payload wasn't a usable card. */
  set(sessionId: string, raw: unknown): BrainCard | null {
    const card = normalizeCard(raw);
    if (!card) return null;
    let m = this.bySession.get(sessionId);
    if (isEmptyCard(card)) { m?.delete(card.id); if (m && m.size === 0) this.bySession.delete(sessionId); return card; }
    if (!m) { m = new Map(); this.bySession.set(sessionId, m); }
    m.set(card.id, card);
    return card;
  }

  /** The current cards for a conversation, in insertion order (empty array when none). */
  forSession(sessionId: string): BrainCard[] {
    const m = this.bySession.get(sessionId);
    return m ? [...m.values()] : [];
  }

  /** Drop all cards for a conversation (session dispose / reset). */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}
