'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import type { SpatialMascotState } from './SpatialMascot.types';

export type { SpatialMascotState } from './SpatialMascot.types';

function StaticMascot({ state }: { state: SpatialMascotState }) {
  return (
    <div className={`spatial-mascot-fallback spatial-mascot-fallback--${state}`} aria-hidden>
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--outer" />
      <span className="spatial-mascot-fallback__ring spatial-mascot-fallback__ring--inner" />
      {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset is the canonical mascot. */}
      <img src="/icon.png" alt="" draggable={false} />
    </div>
  );
}

const SpatialMascotScene = dynamic(
  () => import('./SpatialMascotScene').then((mod) => mod.SpatialMascotScene),
  { ssr: false, loading: () => null },
);

/** Lazy WebGL identity scene with the original mascot visible as an immediate static fallback. */
export function SpatialMascot({ state = 'idle' }: { state?: SpatialMascotState }) {
  const renderWebGl = process.env.NODE_ENV !== 'test';
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => setReady(true), []);
  return (
    <div className="spatial-mascot" role="img" aria-label="Elowen">
      {!ready ? <StaticMascot state={state} /> : null}
      {renderWebGl ? (
        <div className="spatial-mascot__webgl" aria-hidden>
          <SpatialMascotScene state={state} onReady={markReady} />
        </div>
      ) : null}
    </div>
  );
}
