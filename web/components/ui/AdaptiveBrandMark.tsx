import type { CSSProperties } from 'react';

export function AdaptiveBrandMark({
  src,
  size,
  monochrome = false,
  alt = '',
  className = '',
  onError,
}: {
  src: string;
  size: number;
  monochrome?: boolean;
  alt?: string;
  className?: string;
  onError?: () => void;
}) {
  if (monochrome) {
    const style: CSSProperties = {
      width: size,
      height: size,
      backgroundColor: 'currentColor',
      WebkitMaskImage: `url("${src}")`,
      maskImage: `url("${src}")`,
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
    };
    return (
      <span
        className={`inline-block shrink-0 ${className}`}
        data-brand-mark="monochrome"
        style={style}
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      />
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      className={`shrink-0 object-contain ${className}`}
      data-brand-mark="color"
      style={{ width: size, height: size }}
      aria-hidden={alt ? undefined : true}
      onError={onError}
    />
  );
}
