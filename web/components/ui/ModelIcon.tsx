'use client';
import { Cpu } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { modelIconSlug } from '../../lib/modelIcon';

/** Brand icon for a model, resolved from its name/exec string via lobe-icons.
 *  Mono (currentColor) variants are inverted so they read on the OLED surface. */
export function ModelIcon({ name, size = 20, className = '' }: { name?: string | null; size?: number; className?: string }) {
  const icon = modelIconSlug(name);
  const [fallback, setFallback] = useState(false);
  const [failed, setFailed] = useState(false);
  // Reset per icon so a name change from a missing icon to a good one re-tries the asset.
  useEffect(() => { setFallback(false); setFailed(false); }, [icon?.slug]);

  const onError = useCallback(() => {
    // color icon: svg missing → try the webp raster; anything else missing → give up on the <img>
    // and render the generic glyph so there's no broken image (and the 404 loop stops).
    if (icon?.color && !fallback) setFallback(true);
    else setFailed(true);
  }, [icon?.color, fallback]);

  if (!icon || failed) return <Cpu size={size} className={`text-text-muted ${className}`} aria-hidden />;

  const ext = icon.color && fallback ? 'webp' : 'svg';
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/models/${icon.slug}.${ext}`}
      alt=""
      className={`shrink-0 object-contain ${icon.color ? '' : 'invert'} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
      onError={onError}
    />
  );
}
