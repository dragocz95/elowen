'use client';

import { useEffect, useRef } from 'react';
import { useEffects } from '../../lib/useEffects';
import { useSkin } from '../../lib/skinContext';

/** Ambient ember drizzle — tiny red sparks slowly falling down the navigation rail behind its items.
 *  Scoped to the rail rather than the whole app: over a full viewport the same density reads as dust on
 *  the screen, while in one narrow column it reads as the nav itself smouldering. Renders only when the
 *  resolved effects mode is 'full', so reduced/off devices and prefers-reduced-motion users never see
 *  motion.
 *
 *  Sizes itself from its own box (it stretches to the host via `inset: 0`), so the host only has to be a
 *  containing block — no dimensions are passed in and none are read off the window. */
export function EmberFall() {
  const { resolvedMode } = useEffects();
  // A canvas paints with colour STRINGS and cannot read a CSS custom property, so the two ember tones
  // are resolved off the live document below. The skin choice is a dependency of that effect: switching
  // the design re-runs it, instead of leaving the drizzle burning in the previous palette's accent.
  const { choice: skin } = useSkin();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (resolvedMode !== 'full') return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const warmTone = token('--color-ember');
    const hotTone = token('--color-primary');

    interface Ember { x: number; y: number; r: number; fall: number; sway: number; phase: number; opacity: number; warm: boolean }
    let embers: Ember[] = [];
    let width = 0;
    let height = 0;
    let raf = 0;
    let last = performance.now();

    const size = () => {
      // Measured off the HOST, never off the canvas. A canvas is a replaced element whose layout size
      // follows its bitmap attributes, so measuring itself and then writing `canvas.width` feeds straight
      // back into the observer: each pass multiplies by `dpr` and the element runs away exponentially
      // (dpr 2 reached 33M px within a second, drawing one giant blurred ember over the whole rail). The
      // host is absolutely-positioned-out-of, so its size can never depend on ours.
      const host = canvas.parentElement;
      if (!host) return;
      width = host.clientWidth;
      height = host.clientHeight;
      if (width === 0 || height === 0) { embers = []; return; } // collapsed/hidden rail — nothing to draw
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Density scales with the rail's own area. Tuned for a column, not a viewport: the same divisor that
      // kept a full screen sparse would leave barely a handful of sparks in a 17rem strip.
      const count = Math.max(24, Math.min(120, Math.round((width * height) / 3600)));
      embers = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.6 + Math.random() * 1.2,
        fall: 11 + Math.random() * 20, // px/s — a slow drizzle
        sway: 4 + Math.random() * 7,
        phase: Math.random() * Math.PI * 2,
        opacity: 0.12 + Math.random() * 0.22,
        warm: Math.random() < 0.35,
      }));
    };

    const tick = (now: number) => {
      const dt = Math.min(now - last, 64) / 1000;
      last = now;
      ctx.clearRect(0, 0, width, height);
      for (const e of embers) {
        e.y += e.fall * dt;
        if (e.y > height + 4) {
          e.y = -4;
          e.x = Math.random() * width;
        }
        const twinkle = e.opacity * (0.55 + 0.45 * Math.sin(now / 1100 + e.phase));
        const tone = e.warm ? warmTone : hotTone;
        ctx.beginPath();
        ctx.arc(e.x + Math.sin(now / 2600 + e.phase) * e.sway, e.y, e.r, 0, Math.PI * 2);
        // The twinkle rides on globalAlpha rather than being composed into the colour string, so the
        // tone can stay exactly what the token resolved to — whatever notation the skin spelled it in.
        ctx.globalAlpha = twinkle;
        ctx.fillStyle = tone;
        // A whisper of glow so the spark reads as an ember, not a dead pixel. It shares the spark's
        // alpha, so the halo breathes with the ember instead of holding a constant ring around it.
        ctx.shadowColor = tone;
        ctx.shadowBlur = e.r * 3;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    };

    size();
    // The rail resizes on its own (rail↔full pin, dock side, drawer) without the window ever changing, so
    // this observes the element rather than listening for `resize` — the host, matching what `size` reads.
    const observer = new ResizeObserver(size);
    observer.observe(canvas.parentElement ?? canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [resolvedMode, skin]);

  if (resolvedMode !== 'full') return null;
  return <canvas ref={canvasRef} className="ember-fall" aria-hidden="true" />;
}
