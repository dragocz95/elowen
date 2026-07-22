'use client';
import { useEffect, useRef, type RefObject } from 'react';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The trunk filament: one continuous curve flowing out of the mascot's core down into the journal,
 *  then straight along the spine through every docked event/task dot (`[data-trunk-dot]`). Purely
 *  decorative — it reuses the cosmos filament classes (base line + drifting flow overlay) and only
 *  draws while the hero cosmos is in orbit mode; in stack mode (and jsdom) the per-row beam
 *  segments keep the spine role. */
export function JournalTrunk({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const svg = svgRef.current;
    if (!container || !svg) return;

    const draw = () => {
      svg.replaceChildren();
      const cosmos = container.querySelector<HTMLElement>('.hero-cosmos');
      const core = container.querySelector<HTMLElement>('.hero-cosmos__core');
      const dots = Array.from(container.querySelectorAll<HTMLElement>('[data-trunk-dot]'));
      const orbit = cosmos?.dataset.mode === 'orbit' && core != null && dots.length > 0;
      container.classList.toggle('dashboard-field--trunk', orbit);
      if (!orbit) return;
      const box = container.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${container.clientWidth} ${container.clientHeight}`);
      const coreBox = core.getBoundingClientRect();
      // Leave the core just under the mascot, inside its aura, so the trunk reads as growing out of it.
      const cx = coreBox.left + coreBox.width / 2 - box.left;
      const cy = coreBox.top + coreBox.height * 0.78 - box.top;
      const pts = dots.map((dot) => {
        const r = dot.getBoundingClientRect();
        return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
      });
      const sx = pts[0].x;
      const sy = pts[0].y;
      const endY = pts[pts.length - 1].y;
      // Dive down out of the core first, then approach the spine from above — a shallow horizontal
      // sweep would drag the filament across the journal heading.
      const dy = Math.max(120, sy - cy);
      const d = `M${cx} ${cy} C ${cx} ${cy + dy * 0.55}, ${sx} ${sy - dy * 0.6}, ${sx} ${sy} L ${sx} ${endY}`;
      for (const kind of ['base', 'flow'] as const) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke-width', '1');
        path.classList.add(`cosmos-fil--${kind}`);
        path.style.setProperty('--i', '0');
        svg.appendChild(path);
      }
    };

    draw();
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    resize?.observe(container);
    // Journal rows stream in async; redraw when they land — but ignore our own svg mutations,
    // or the redraw would observe itself forever.
    const mutation = typeof MutationObserver !== 'undefined'
      ? new MutationObserver((entries) => {
          if (entries.some((entry) => !svg.contains(entry.target))) draw();
        })
      : null;
    mutation?.observe(container, { childList: true, subtree: true });

    return () => {
      resize?.disconnect();
      mutation?.disconnect();
      container.classList.remove('dashboard-field--trunk');
    };
  }, [containerRef]);

  return <svg ref={svgRef} className="dashboard-trunk" aria-hidden="true" />;
}
