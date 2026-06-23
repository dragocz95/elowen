'use client';
import type { InputHTMLAttributes } from 'react';

/** A thin range input themed to the app accent. The host owns the value; `onChange` reports the
 *  parsed number (not the raw event). */
export function Slider({ value, onChange, min = 0, max = 100, step = 1, className = '', ...rest }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'type'>) {
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className={`h-1.5 w-full cursor-pointer appearance-none rounded-full bg-elevated accent-accent ${className}`}
      {...rest}
    />
  );
}
