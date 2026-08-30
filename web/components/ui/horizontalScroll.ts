const EDGE_EPSILON = 1;

function wheelUnit(track: HTMLElement, deltaMode: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_PIXEL) return 1;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return Math.max(1, track.clientHeight);

  const lineHeight = Number.parseFloat(getComputedStyle(track).lineHeight);
  return Number.isFinite(lineHeight) && lineHeight > 0
    ? lineHeight
    : Math.max(1, track.clientHeight);
}

/** Convert dominant vertical wheel input into bounded horizontal movement.
 *
 * Ctrl+wheel is reserved for browser zoom/pinch. The event is consumed only after scrollLeft actually
 * changes, so a fitting track and either bounded edge continue scrolling the page normally. */
export function consumeHorizontalWheel(track: HTMLElement, event: WheelEvent): boolean {
  if (event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return false;

  const delta = event.deltaY * wheelUnit(track, event.deltaMode);
  if (!Number.isFinite(delta) || delta === 0) return false;

  const maxScrollLeft = Math.max(0, track.scrollWidth - track.clientWidth);
  const before = track.scrollLeft;
  const target = Math.max(0, Math.min(maxScrollLeft, before + delta));
  if (Math.abs(target - before) <= EDGE_EPSILON) return false;

  track.scrollLeft = target;
  if (Math.abs(track.scrollLeft - before) <= EDGE_EPSILON) return false;
  event.preventDefault();
  return true;
}

/** Keep one item visible on the horizontal axis without asking any ancestor page scroller to move. */
export function revealHorizontalItem(track: HTMLElement, item: HTMLElement): boolean {
  const trackRect = track.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  let delta = 0;
  if (itemRect.left < trackRect.left) delta = itemRect.left - trackRect.left;
  else if (itemRect.right > trackRect.right) delta = itemRect.right - trackRect.right;
  if (Math.abs(delta) <= EDGE_EPSILON) return false;

  const maxScrollLeft = Math.max(0, track.scrollWidth - track.clientWidth);
  const before = track.scrollLeft;
  track.scrollLeft = Math.max(0, Math.min(maxScrollLeft, before + delta));
  return Math.abs(track.scrollLeft - before) > EDGE_EPSILON;
}
