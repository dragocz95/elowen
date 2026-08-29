'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cva } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

const sliderVariants = cva([
  'relative flex w-full touch-none select-none items-center',
  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
  'data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col',
]);

/** Radix puts slider semantics on each thumb rather than the root. `thumbProps` lets the app wrapper
 * preserve the scalar input's accessible name and value text on that actual control. */
type SliderProps = React.ComponentProps<typeof SliderPrimitive.Root> & {
  thumbProps?: React.ComponentProps<typeof SliderPrimitive.Thumb>;
};

function Slider({
  className = '',
  defaultValue,
  value,
  min = 0,
  max = 100,
  thumbProps,
  ...props
}: SliderProps) {
  const values = React.useMemo(
    () => (Array.isArray(value) ? value : Array.isArray(defaultValue) ? defaultValue : [min]),
    [defaultValue, min, value],
  );

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(sliderVariants(), className)}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          'relative h-1.5 w-full grow overflow-hidden rounded-full bg-secondary',
          'data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5',
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            'absolute h-full bg-primary',
            'data-[orientation=vertical]:w-full',
          )}
        />
      </SliderPrimitive.Track>
      {values.map((_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          {...thumbProps}
          className={cn(
            'block size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm outline-none transition-[box-shadow]',
            'hover:ring-4 hover:ring-accent focus-visible:ring-4 focus-visible:ring-ring/50',
            'disabled:pointer-events-none disabled:opacity-50',
            thumbProps?.className,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
}

export { Slider };
