'use client';
import { Cpu } from 'lucide-react';
import { modelIconSlug } from '../../lib/modelIcon';

/** Brand icon for a model, resolved from its name/exec string via lobe-icons.
 *  Mono (currentColor) variants are inverted so they read on the OLED surface. */
export function ModelIcon({ name, size = 20, className = '' }: { name?: string | null; size?: number; className?: string }) {
  const icon = modelIconSlug(name);
  if (!icon) return <Cpu size={size} className={`text-text-muted ${className}`} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/models/${icon.slug}.svg`}
      alt=""
      className={`shrink-0 object-contain ${icon.color ? '' : 'invert'} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
