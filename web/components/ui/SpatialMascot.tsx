'use client';

import dynamic from 'next/dynamic';
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useBrand } from '../../lib/brand';
import type { SpatialMascotState } from './SpatialMascot.types';

export type { SpatialMascotState } from './SpatialMascot.types';

function StaticMascot({ state, iconSrc }: { state: SpatialMascotState; iconSrc: string }) {
  // A themed icon URL can go stale (it carries `?v=`; a tab open across a theme switch gets 404s) —
  // degrade to the built-in icon instead of an empty mascot box.
  const [src, setSrc] = useState(iconSrc);
  useEffect(() => setSrc(iconSrc), [iconSrc]);
  return (
    <div className={`spatial-mascot-fallback spatial-mascot-fallback--${state}`} aria-hidden>
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--outer" />
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--inner" />
      {/* eslint-disable-next-line @next/next/no-img-element -- the instance's mascot asset (themeable). */}
      <img src={src} alt="" draggable={false} onError={() => { if (src !== '/icon.png') setSrc('/icon.png'); }} />
    </div>
  );
}

/** The WebGL scene's texture loads with a thrown-promise loader: a FAILED load (that same stale `?v=`
 *  URL) throws to the nearest error boundary, and without one it would take the whole page tree down.
 *  This boundary contains it so the static mascot simply stays. */
class SceneBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(): void { this.props.onError(); }
  override render(): ReactNode { return this.state.failed ? null : this.props.children; }
}

/** The mascot WITHOUT the WebGL layer, for boxes too small to frame the scene.
 *
 *  The 3D camera is orthographic at a fixed zoom, so world units map to a fixed pixel count and the owl
 *  renders at roughly 179px whatever its container measures. The hero and onboarding are large enough and
 *  rescale themselves with a CSS transform on top; anything smaller crops the sprite instead, so a
 *  rail-sized box shows only the middle of its face. This layer is sized in percentages, so it is correct
 *  at any size, and it keeps the per-state ember animation that makes the mascot read as alive. */
export function MascotGlyph({ state = 'idle' }: { state?: SpatialMascotState }) {
  const { appName, mascotSrc } = useBrand();
  return (
    <div className="spatial-mascot" role="img" aria-label={appName}>
      <StaticMascot state={state} iconSrc={mascotSrc} />
    </div>
  );
}

const SpatialMascotScene = dynamic(
  () => import('./SpatialMascotScene').then((mod) => mod.SpatialMascotScene),
  { ssr: false, loading: () => null },
);

/** Set once the WebGL scene has painted at least once this session. Persists across client-side navigations
 *  (same module instance in the SPA) but resets on a full page reload — so the very first cold load shows
 *  the static fallback, while every later page switch skips it (the chunk + WebGL are primed and repaint
 *  fast). Prevents the plain-icon fallback from flashing on every navigation before the scene fades in. */
let sceneWarmedUp = false;

/** Lazy WebGL identity scene with the original mascot visible as an immediate static fallback.
 *  Two ways a theme opts out, and the layer must never mount in either: a theme carrying an ANIMATED
 *  mascot (mascot.svg) would have its animation frozen into a static texture by the scene, and a theme
 *  can also switch the scene off outright (`mascotScene: false`) to show its artwork as a plain image.
 *  Hiding the canvas in CSS is NOT equivalent — the scene still runs, and once it reports ready the
 *  static fallback unmounts, leaving an empty hero. */
export function SpatialMascot({ state = 'idle' }: { state?: SpatialMascotState }) {
  const { appName, mascotSrc, mascotAnimated, mascotScene } = useBrand();
  const renderWebGl = process.env.NODE_ENV !== 'test' && mascotScene && !mascotAnimated;
  // On a warm navigation the scene is already primed, so start ready with no fallback: show the WebGL layer
  // straight away and let it repaint (fast when warm) instead of flashing the plain static icon + crossfade.
  const warm = sceneWarmedUp && renderWebGl;
  const [ready, setReady] = useState(warm);
  const [fallbackVisible, setFallbackVisible] = useState(!warm);
  const [sceneFailed, setSceneFailed] = useState(false);
  const markReady = useCallback(() => { sceneWarmedUp = true; setReady(true); }, []);
  const failScene = useCallback(() => { setSceneFailed(true); setReady(false); setFallbackVisible(true); }, []);

  useEffect(() => {
    if (!ready || !fallbackVisible) return;
    const timer = window.setTimeout(() => setFallbackVisible(false), 460);
    return () => window.clearTimeout(timer);
  }, [ready, fallbackVisible]);

  return (
    <div className={`spatial-mascot ${ready ? 'spatial-mascot--ready' : ''}`} role="img" aria-label={appName}>
      {fallbackVisible ? <StaticMascot state={state} iconSrc={mascotSrc} /> : null}
      {renderWebGl && !sceneFailed ? (
        <div className="spatial-mascot__webgl" aria-hidden>
          <SceneBoundary onError={failScene}>
            <SpatialMascotScene state={state} iconSrc={mascotSrc} onReady={markReady} />
          </SceneBoundary>
        </div>
      ) : null}
    </div>
  );
}
