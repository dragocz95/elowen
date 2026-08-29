'use client';

import type { ComponentProps, InputHTMLAttributes } from 'react';

import { Slider as SliderPrimitive } from './shadcn/slider';

/** A scalar app wrapper over Radix Slider's controlled value array. */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, className = '', ...rest }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'type'>) {
  const {
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'aria-describedby': ariaDescribedBy,
    'aria-valuetext': ariaValueText,
    ...rootProps
  } = rest;
  const radixProps = rootProps as unknown as Omit<
    ComponentProps<typeof SliderPrimitive>,
    'className' | 'value' | 'onValueChange' | 'min' | 'max' | 'step' | 'thumbProps'
  >;

  return (
    <SliderPrimitive
      {...radixProps}
      value={[value]}
      min={min}
      max={max}
      step={step}
      thumbProps={{
        'aria-label': ariaLabel,
        'aria-labelledby': ariaLabelledBy,
        'aria-describedby': ariaDescribedBy,
        'aria-valuetext': ariaValueText,
      }}
      onValueChange={([next]) => {
        if (next !== undefined) onChange(next);
      }}
      className={className}
    />
  );
}
