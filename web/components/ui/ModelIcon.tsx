'use client';
import { Cpu } from 'lucide-react';
import { useCallback, useState } from 'react';
import { modelIconSlug } from '../../lib/modelIcon';

/** Brand icon for a model, resolved from its name/exec string via lobe-icons.
 *  Mono (currentColor) variants are inverted so they read on the OLED surface. */
export function ModelIcon({ name, size = 20, className = '' }: { name?: string | null; size?: number; className?: string }) {
  const icon = modelIconSlug(name);
  const [fallback, setFallback] = useState(false);

  const onError = useCallback(() => {
    if (icon?.color && !fallback) setFallback(true);
  }, [icon?.color, fallback]);

  if (!icon) return <Cpu size={size} className={`text-text-muted ${className}`} aria-hidden />;

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
