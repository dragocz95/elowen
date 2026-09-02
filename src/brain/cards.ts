import type { BrainCard, BrainCardItem } from './events.js';

const STATUSES = new Set(['pending', 'in_progress', 'completed']);
// Bounds enforced at the emit boundary so an oversized card can't flood a client (the CLI renders a
// pinned card into the FIXED bottom stack — an uncapped body/list would overrun the terminal height).
const MAX_ITEMS = 50;
const MAX_TEXT = 200;
const MAX_TITLE = 120;
const MAX_BODY = 2000;
// An item's structured fields are handles and chips, never prose: an id identifies a row, an owner names
// a person. Capping them well below MAX_TEXT keeps a hostile plugin from smuggling a second body through
// the side channel a renderer lays out beside the text.
const MAX_ITEM_ID = 64;
const MAX_OWNER = 64;
const MAX_BLOCKED_BY = 20;

/** The structured, additive half of a checklist row (see BrainCardItem). Absent fields are simply not
 *  emitted, so an item stays byte-identical to what an older producer sent. */
function normalizeItemDetail(item: Record<string, unknown>): Omit<BrainCardItem, 'text' | 'status' | 'startedAt'> {
  const id = typeof item.id === 'string' ? item.id.trim().slice(0, MAX_ITEM_ID) : '';
  const label = typeof item.label === 'string' ? item.label.trim().slice(0, MAX_TEXT) : '';
  const owner = typeof item.owner === 'string' ? item.owner.trim().slice(0, MAX_OWNER) : '';
  const blockedBy = (Array.isArray(item.blockedBy) ? item.blockedBy : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().slice(0, MAX_ITEM_ID))
    .filter((value) => value !== '')
    .slice(0, MAX_BLOCKED_BY);
  return {
    ...(id ? { id } : {}),
    ...(label ? { label } : {}),
    ...(owner ? { owner } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
  };
}

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
    const item = it as Record<string, unknown>;
    const text = String(item.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) continue;
    const status = item.status;
    const startedAt = typeof item.startedAt === 'number' && Number.isFinite(item.startedAt) && item.startedAt >= 0
      ? item.startedAt
      : undefined;
    items.push({
      text,
      status: STATUSES.has(status as string) ? (status as BrainCardItem['status']) : 'pending',
      ...(startedAt != null ? { startedAt } : {}),
      ...normalizeItemDetail(item),
    });
  }
  const body = typeof o.body === 'string' && o.body.trim() ? o.body.slice(0, MAX_BODY) : undefined;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.slice(0, MAX_TITLE) : undefined;
  return { id, title, items: items.length ? items : undefined, body, pinned: o.pinned === true };
}

/** Whether a normalized card carries no content — the signal to remove it from the panel. */
export function isEmptyCard(c: BrainCard): boolean {
  return (!c.items || c.items.length === 0) && !c.body;
}

/** Where a conversation's cards are kept between daemon lives — BrainStore in production. */
export interface CardStore {
  upsertCard(sessionId: string, card: BrainCard): void;
  deleteCard(sessionId: string, cardId: string): void;
  getCards(sessionId: string): BrainCard[];
}

/** The set of display cards per conversation (keyed by card id). One instance is owned by BrainService;
 *  a client seeds from it on connect (via /brain/status) and then keeps it current from the `card` event
 *  stream. Mirrors ElicitationRegistry's role for parked questions.
 *
 *  Cards are CONVERSATION state, not session state, so this is a write-through cache over the store
 *  rather than a plain map: closing the chat disposes the live session, and a memory-only panel would
 *  take the user's todo list with it. Backed by the store, a reopened conversation gets its checklist
 *  back — and it survives a daemon restart too, which no in-memory registry ever could. */
export class CardRegistry {
  private readonly bySession = new Map<string, Map<string, BrainCard>>();

  /** The store is read through a thunk so BrainService can wire this up as a field initializer, before
   *  its own dependencies are assigned. Omitted in minimal/test wirings: the registry then behaves as
   *  the pure in-memory cache it used to be. */
  constructor(private readonly store: () => CardStore | undefined = () => undefined) {}

  /** Upsert (or, for an empty card, remove) a card and return the normalized value to broadcast, or null
   *  when the payload wasn't a usable card. */
  set(sessionId: string, raw: unknown): BrainCard | null {
    const card = normalizeCard(raw);
    if (!card) return null;
    const cards = this.load(sessionId);
    if (isEmptyCard(card)) {
      cards.delete(card.id);
      this.store()?.deleteCard(sessionId, card.id);
      return card;
    }
    cards.set(card.id, card);
    this.store()?.upsertCard(sessionId, card);
    return card;
  }

  /** The current cards for a conversation, in insertion order (empty array when none). */
  forSession(sessionId: string): BrainCard[] {
    return [...this.load(sessionId).values()];
  }

  /** Evict a conversation from the CACHE — on session dispose, when the user closes the chat. The stored
   *  panel deliberately survives; `forSession` reloads it when the conversation is opened again. Deleting
   *  the conversation is what drops the cards for good, through the store's own cascade. */
  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private load(sessionId: string): Map<string, BrainCard> {
    let cards = this.bySession.get(sessionId);
    if (!cards) {
      cards = new Map((this.store()?.getCards(sessionId) ?? []).map((c) => [c.id, c]));
      this.bySession.set(sessionId, cards);
    }
    return cards;
  }
}
