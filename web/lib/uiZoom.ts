/** Current UI-scale zoom factor — the `zoom: z` the UI-scale feature puts on <html> (mirrored into the
 *  `--ui-scale` CSS var). A body-portalled, fixed-positioned element lives *inside* that zoom, so its
 *  CSS px render at z×. Coordinates read from `getBoundingClientRect()` / `MouseEvent.clientX|Y` are
 *  already zoomed (visual) viewport values, so any such coordinate used as a fixed CSS position must be
 *  divided by this factor — otherwise the element is flung off-target at any scale ≠ 100%.
 *  Returns 1 when the var is unset (SSR, or scale at 100%), making every caller a no-op at normal scale. */
export function uiZoom(): number {
  if (typeof document === 'undefined') return 1;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
}
