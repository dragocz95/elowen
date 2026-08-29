'use client';

import { useEffect, useState } from 'react';
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

/** The mascot: the instance's themeable artwork with the per-state ember ring that makes it read as alive.
 *
 *  It has no intrinsic size: everything inside is sized in percentages, so it fills whatever box the
 *  caller gives it. The advisor's TelemetryPanel and CommandOrbit are its callers today. */
export function MascotGlyph({ state = 'idle' }: { state?: SpatialMascotState }) {
  const { appName, mascotSrc } = useBrand();
  return (
    <div className="spatial-mascot" role="img" aria-label={appName}>
      <StaticMascot state={state} iconSrc={mascotSrc} />
    </div>
  );
}
