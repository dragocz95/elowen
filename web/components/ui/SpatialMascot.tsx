'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import { useBrand } from '../../lib/brand';
import type { SpatialMascotState } from './SpatialMascot.types';

export type { SpatialMascotState } from './SpatialMascot.types';

function StaticMascot({ state, iconSrc }: { state: SpatialMascotState; iconSrc: string }) {
  return (
    <div className={`spatial-mascot-fallback spatial-mascot-fallback--${state}`} aria-hidden>
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--outer" />
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--inner" />
      {/* eslint-disable-next-line @next/next/no-img-element -- the instance's mascot asset (themeable). */}
      <img src={iconSrc} alt="" draggable={false} />
    </div>
  );
}

/** The mascot WITHOUT the WebGL layer, for boxes too small to frame the scene.
 *
 *  The 3D camera is orthographic at a fixed zoom, so world units map to a fixed pixel count and the owl
 *  renders at roughly 179px whatever its container measures. The hero and onboarding are large enough and
 *  rescale themselves with a CSS transform on top; anything smaller crops the sprite instead, so a
 *  rail-sized box shows only the middle of its face. This layer is sized in percentages, so it is correct
 *  at any size, and it keeps the per-state ember animation that makes the mascot read as alive. */
export function MascotGlyph({ state = 'idle' }: { state?: SpatialMascotState }) {
  const { appName, iconSrc } = useBrand();
  return (
    <div className="spatial-mascot" role="img" aria-label={appName}>
      <StaticMascot state={state} iconSrc={iconSrc} />
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

/** Lazy WebGL identity scene with the original mascot visible as an immediate static fallback. */
export function SpatialMascot({ state = 'idle' }: { state?: SpatialMascotState }) {
  const { appName, iconSrc } = useBrand();
  const renderWebGl = process.env.NODE_ENV !== 'test';
  // On a warm navigation the scene is already primed, so start ready with no fallback: show the WebGL layer
  // straight away and let it repaint (fast when warm) instead of flashing the plain static icon + crossfade.
  const warm = sceneWarmedUp && renderWebGl;
  const [ready, setReady] = useState(warm);
  const [fallbackVisible, setFallbackVisible] = useState(!warm);
  const markReady = useCallback(() => { sceneWarmedUp = true; setReady(true); }, []);

  useEffect(() => {
    if (!ready || !fallbackVisible) return;
    const timer = window.setTimeout(() => setFallbackVisible(false), 460);
    return () => window.clearTimeout(timer);
  }, [ready, fallbackVisible]);

  return (
    <div className={`spatial-mascot ${ready ? 'spatial-mascot--ready' : ''}`} role="img" aria-label={appName}>
      {fallbackVisible ? <StaticMascot state={state} iconSrc={iconSrc} /> : null}
      {renderWebGl ? (
        <div className="spatial-mascot__webgl" aria-hidden>
          <SpatialMascotScene state={state} iconSrc={iconSrc} onReady={markReady} />
        </div>
      ) : null}
    </div>
  );
}
