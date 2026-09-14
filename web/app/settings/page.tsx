export const dynamic = 'force-dynamic';

/** `/settings` is PRESENTED by the `@pageOverlay` slot — the interceptor for a client navigation, the
 *  plain route beside it for every other arrival. This page owns the address and nothing else.
 *
 *  It used to render the deck a second time, as a standalone full-page Settings. That is what made one
 *  address look like two different products: a hard load or a refresh showed the standalone page because
 *  nothing was intercepted, and a client navigation could paint it for a frame before the intercepted
 *  overlay replaced it. One presentation cannot be owned by two route trees, so the deck lives in the
 *  slot and this route contributes no content of its own.
 *
 *  It stays a route rather than being deleted: the canonical page is what makes `/settings` an address
 *  the router can reach at all, and what the interceptor intercepts. */
export default function SettingsPage() {
  return null;
}
