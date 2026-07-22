'use client';

import { useEffect, useRef } from 'react';
import { useEffects } from '../../lib/useEffects';

/** Ambient ember drizzle — tiny red sparks slowly falling across the whole app behind the content.
 *  Deliberately faint (low count, low opacity, gentle sway + twinkle) so it reads as atmosphere, not
 *  decoration. Renders only when the resolved effects mode is 'full', so reduced/off devices and
 *  prefers-reduced-motion users never see motion. */
export function EmberFall() {
  const { resolvedMode } = useEffects();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (resolvedMode !== 'full') return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    interface Ember { x: number; y: number; r: number; fall: number; sway: number; phase: number; opacity: number; warm: boolean }
    let embers: Ember[] = [];
    let raf = 0;
    let last = performance.now();

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Density scales with viewport area but stays sparse — "a little glitter", not snowfall.
      const count = Math.max(14, Math.min(44, Math.round((window.innerWidth * window.innerHeight) / 60000)));
      embers = Array.from({ length: count }, () => ({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: 0.5 + Math.random() * 0.9,
        fall: 9 + Math.random() * 16, // px/s — a slow drizzle
        sway: 4 + Math.random() * 7,
        phase: Math.random() * Math.PI * 2,
        opacity: 0.05 + Math.random() * 0.14,
        warm: Math.random() < 0.35,
      }));
    };

    const tick = (now: number) => {
      const dt = Math.min(now - last, 64) / 1000;
      last = now;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      for (const e of embers) {
        e.y += e.fall * dt;
        if (e.y > window.innerHeight + 4) {
          e.y = -4;
          e.x = Math.random() * window.innerWidth;
        }
        const twinkle = e.opacity * (0.55 + 0.45 * Math.sin(now / 1100 + e.phase));
        ctx.beginPath();
        ctx.arc(e.x + Math.sin(now / 2600 + e.phase) * e.sway, e.y, e.r, 0, Math.PI * 2);
        ctx.fillStyle = e.warm ? `rgb(255 154 98 / ${twinkle.toFixed(3)})` : `rgb(255 82 54 / ${twinkle.toFixed(3)})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };

    size();
    window.addEventListener('resize', size);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', size);
    };
  }, [resolvedMode]);

  if (resolvedMode !== 'full') return null;
  return <canvas ref={canvasRef} className="ember-fall" aria-hidden="true" />;
}
