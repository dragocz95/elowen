'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

/** PROTOTYPE — "constellation" layout for account sections. Inside a ConstellationScope the shared
 *  SpatialGroup/SpatialRow primitives render as an orbital field instead of stacked rows: the group
 *  becomes a cosmos with a glowing core, and each row becomes a floating pod tied to the core by a
 *  filament. Everything is additive — removing the scope wrapper (or flipping the flag in
 *  AccountView) restores the classic layout untouched. */

interface ConstellationValue { core: string }

const ConstellationContext = createContext<ConstellationValue | null>(null);

export function useConstellation(): ConstellationValue | null {
  return useContext(ConstellationContext);
}

export function ConstellationScope({ core, children }: { core: string; children: ReactNode }) {
  return <ConstellationContext.Provider value={{ core }}>{children}</ConstellationContext.Provider>;
}

/** Below this container width the orbit collapses into a vertical stream (phones, narrow panes). */
const ORBIT_MIN_WIDTH_PX = 832;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The orbital surface: positions its `.cosmos-pod` children on an ellipse around the core and draws
 *  curved SVG filaments from the core to each pod. Layout is DOM-measured (pod heights vary), so it
 *  re-runs on resize and on pod content changes; entrance animations replay whenever the cosmos
 *  becomes visible again (section rail navigation keeps panels mounted via <Activity>). */
export function CosmosGroup({ core, children }: { core: string; children: ReactNode }) {
  const rootRef = useRef<HTMLElement>(null);
  const podsRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const podsLayer = podsRef.current;
    const svg = svgRef.current;
    const ring = ringRef.current;
    const coreEl = coreRef.current;
    if (!root || !podsLayer || !svg || !ring || !coreEl) return;

    const layout = () => {
      const pods = Array.from(podsLayer.querySelectorAll<HTMLElement>(':scope > .cosmos-pod'));
      pods.forEach((pod, i) => {
        pod.dataset.i = String(i);
        pod.style.setProperty('--i', String(i));
      });
      const width = root.clientWidth;
      const orbit = width >= ORBIT_MIN_WIDTH_PX && pods.length > 0;
      root.dataset.mode = orbit ? 'orbit' : 'stack';
      // Sparse constellations (1–2 pods) sit BESIDE the core and get a flatter field — stacking a
      // lone pair above/below the mascot wastes a wide screen. Set before measuring: the height
      // rule keys off this attribute.
      root.dataset.density = pods.length <= 2 ? 'sparse' : 'dense';
      svg.replaceChildren();
      if (!orbit) {
        root.style.height = '';
        for (const pod of pods) {
          pod.style.left = '';
          pod.style.top = '';
          pod.style.removeProperty('--fx');
          pod.style.removeProperty('--fy');
        }
        return;
      }
      // Fit the orbit into the viewport space remaining below its own top edge, so the section
      // itself never forces the page to scroll (the CSS clamp stays as the pre-measure fallback).
      // Tiny screens still get the minimum height — a scrollbar beats an unusable field there.
      const scroller = root.closest('main');
      if (scroller) {
        const offset = root.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        // Everything after the cosmos (surface/deck/shell paddings) measured live: total scrollable
        // content minus what sits above the cosmos and the cosmos itself. Invariant to our height.
        const below = Math.max(0, scroller.scrollHeight - offset - root.offsetHeight);
        const minH = (pods.length <= 2 ? 24 : 30) * 16;
        const desired = Math.round(Math.max(minH, Math.min(scroller.clientHeight - offset - below, 64 * 16)));
        if (Math.abs(root.offsetHeight - desired) > 1) root.style.height = `${desired}px`;
      }
      const height = root.clientHeight;
      const cx = width / 2;
      const cy = height / 2;
      const rx = Math.min(width * 0.45, 38 * 16);
      const ry = height * 0.38;
      ring.style.width = `${rx * 2 + 140}px`;
      ring.style.height = `${Math.min(ry * 2 + 110, height - 16)}px`;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      // Phase 1 — ideal spots on the ellipse. Pods have very different heights (a lone toggle vs.
      // the auto-compact composite), so ideal spots can collide.
      // 1 pod → east of the core; 2 pods → west & east; 3+ → the full ellipse starting at north.
      const startDeg = pods.length === 1 ? 0 : pods.length === 2 ? 180 : -90;
      const placed = pods.map((pod, i) => {
        const angle = ((startDeg + (i * 360) / pods.length) * Math.PI) / 180;
        // Alternate the radius slightly so the arrangement doesn't read as a mechanical circle —
        // except for sparse pairs, which should mirror each other symmetrically.
        const wobble = pods.length <= 2 ? 1 : 1 + (i % 2 ? 0.05 : -0.04);
        return {
          pod,
          x: cx + rx * wobble * Math.cos(angle),
          y: cy + ry * wobble * Math.sin(angle),
          w: pod.offsetWidth,
          h: pod.offsetHeight,
        };
      });
      // Phase 2 — relax overlaps: push colliding pairs apart along the axis of least overlap, then
      // clamp everything back inside the surface. A few iterations settle real layouts.
      const gap = 14;
      const clampAll = () => {
        for (const p of placed) {
          p.x = Math.min(Math.max(p.x, p.w / 2 + 8), width - p.w / 2 - 8);
          p.y = Math.min(Math.max(p.y, p.h / 2 + 8), height - p.h / 2 - 8);
        }
      };
      clampAll();
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (let a = 0; a < placed.length; a++) {
          for (let b = a + 1; b < placed.length; b++) {
            const A = placed[a], B = placed[b];
            const ox = (A.w + B.w) / 2 + gap - Math.abs(A.x - B.x);
            const oy = (A.h + B.h) / 2 + gap - Math.abs(A.y - B.y);
            if (ox <= 0 || oy <= 0) continue;
            moved = true;
            if (oy <= ox) {
              const dir = A.y <= B.y ? -1 : 1;
              A.y += (dir * oy) / 2;
              B.y -= (dir * oy) / 2;
            } else {
              const dir = A.x <= B.x ? -1 : 1;
              A.x += (dir * ox) / 2;
              B.x -= (dir * ox) / 2;
            }
          }
        }
        clampAll();
        if (!moved) break;
      }
      // Phase 3 — apply the settled positions and draw the filaments to them.
      placed.forEach(({ pod, x: px, y: py }, i) => {
        pod.style.left = `${px}px`;
        pod.style.top = `${py}px`;
        pod.style.setProperty('--fx', `${cx - px}px`);
        pod.style.setProperty('--fy', `${cy - py}px`);
        // Filament: a gently curved base line plus a "flow" overlay whose dashes drift outward.
        const mx = (cx + px) / 2 + (py - cy) * 0.12;
        const my = (cy + py) / 2 - (px - cx) * 0.12;
        const d = `M${cx} ${cy} Q${mx} ${my} ${px} ${py}`;
        for (const kind of ['base', 'flow'] as const) {
          const path = document.createElementNS(SVG_NS, 'path');
          path.setAttribute('d', d);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-width', '1');
          path.classList.add(`cosmos-fil--${kind}`);
          path.dataset.pod = String(i);
          path.style.setProperty('--i', String(i));
          svg.appendChild(path);
          if (kind === 'base' && typeof path.getTotalLength === 'function') {
            const len = path.getTotalLength();
            path.style.setProperty('--len', String(len));
            path.setAttribute('stroke-dasharray', String(len));
          }
        }
      });
    };

    layout();
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    resize?.observe(root);
    // Conditional row content (e.g. the auto-compact slider appearing) changes pod geometry.
    const mutation = typeof MutationObserver !== 'undefined' ? new MutationObserver(layout) : null;
    mutation?.observe(podsLayer, { childList: true, subtree: true });
    // Replay the entrance whenever the cosmos becomes visible again.
    const intersection = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) root.classList.toggle('cosmos--enter', entry.isIntersecting);
        }, { threshold: 0.15 })
      : null;
    intersection?.observe(root);

    // Hovering a pod lights up its filament and dims the others.
    const setLit = (index: number | null) => {
      for (const path of svg.querySelectorAll('path')) {
        path.classList.remove('is-lit', 'is-dim');
        if (index != null) path.classList.add(Number(path.dataset.pod) === index ? 'is-lit' : 'is-dim');
      }
    };
    const onOver = (event: PointerEvent) => {
      const pod = event.target instanceof Element ? event.target.closest<HTMLElement>('.cosmos-pod') : null;
      setLit(pod?.dataset.i != null ? Number(pod.dataset.i) : null);
    };
    const onOut = () => setLit(null);
    podsLayer.addEventListener('pointerover', onOver);
    podsLayer.addEventListener('pointerleave', onOut);

    return () => {
      resize?.disconnect();
      mutation?.disconnect();
      intersection?.disconnect();
      podsLayer.removeEventListener('pointerover', onOver);
      podsLayer.removeEventListener('pointerleave', onOut);
    };
  }, []);

  return (
    <section ref={rootRef} className="cosmos" data-mode="stack" data-testid="cosmos">
      <svg ref={svgRef} className="cosmos-filaments" aria-hidden="true" />
      <div ref={ringRef} className="cosmos-ring" aria-hidden="true" />
      <div ref={coreRef} className="cosmos-core" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset is the canonical mascot. */}
        <img src="/icon.png" alt="" draggable={false} className="cosmos-core__mascot" />
        <span className="cosmos-core__label">{core}</span>
      </div>
      <div ref={podsRef} className="cosmos-pods">{children}</div>
    </section>
  );
}
