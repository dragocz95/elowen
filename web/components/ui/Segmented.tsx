'use client';

import { useEffect, useRef } from 'react';
import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import { RadioGroup, RadioGroupItem } from './shadcn/radio-group';

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: LucideIcon;
  /** How many records the option leads to. Rendered as a quiet suffix and folded into the accessible
   *  name, so a section that carries a figure keeps it when the control is used as a page's section
   *  navigation — the presentation this replaced showed one and dropping it would lose information. */
  count?: number;
}

const segmentedIconVariants = cva('shrink-0', {
  variants: {
    variant: {
      default: 'size-[13px]',
      line: 'size-[13px]',
      menu: 'size-4',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const segmentedLabelVariants = cva('', {
  variants: {
    variant: {
      default: '',
      line: '',
      menu: 'min-w-0 flex-1 truncate text-left',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const segmentedCountVariants = cva('segmented__count text-muted-foreground', {
  variants: {
    variant: {
      default: '',
      line: '',
      menu: 'ml-auto',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

/** A connected single-choice control for modes, filters, types, priorities and section views.
 *
 *  This is a Radix RadioGroup rather than a ToggleGroup because one value is always selected and clicking
 *  it again must not turn the set off. That gives the control its native `radiogroup` / `radio` roles,
 *  `aria-checked` state, roving tab stop and radio-group arrow/Home/End keyboard model without reimplementing
 *  any of them. The `line` and `menu` variants change presentation only; they retain the same mutually
 *  exclusive selection semantics as the compact field treatment. */
export function Segmented({ options, value, onChange, size = 'md', variant = 'default', className, nowrap = false, 'aria-label': ariaLabel }: {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** `sm` for tight inline rows (e.g. a manual phase line), `md` for full form fields. */
  size?: 'sm' | 'md';
  /** `line` is the quiet horizontal navigation treatment; `menu` is the vertical settings/sidebar shape. */
  variant?: 'default' | 'line' | 'menu';
  className?: string;
  /** Keep the track on one line. Pass it inside the single-line page toolbars so the header row keeps
   *  its shape instead of the control folding onto a second line. The track then SCROLLS when it runs
   *  out of room — at 320px the last option used to sit outside the surface and be clipped away. Off by
   *  default so long option sets (e.g. settings) degrade by wrapping instead. */
  nowrap?: boolean;
  /** Accessible name for the radiogroup — pass it when the control acts as a labelled section nav. */
  'aria-label'?: string;
}) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const orientation = variant === 'menu' ? 'vertical' : 'horizontal';
  const radioSize = size === 'sm' ? 'sm' : 'default';

  useEffect(() => {
    if (!nowrap || selectedIndex < 0) return;
    itemRefs.current[selectedIndex]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [nowrap, selectedIndex]);

  return (
    // `segmented` / `segmented__option` / `segmented__count` are named for the same reason the toolbar
    // and the field are: this control is one of the handful a DESIGN has to be able to restate, and a
    // stylesheet has nothing to hold on to otherwise. The utilities below stay the built-in reading.
    <RadioGroup
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      aria-orientation={orientation}
      variant={variant}
      nowrap={nowrap}
      data-nowrap={nowrap ? 'true' : undefined}
      className={cn('segmented', className)}
    >
      {options.map((option, index) => {
        const Icon = option.icon;
        return (
          <RadioGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.count === undefined ? option.label : `${option.label} ${option.count}`}
            appearance="segmented"
            variant={variant}
            size={radioSize}
            ref={(node) => { itemRefs.current[index] = node; }}
            style={{ transitionDuration: 'var(--motion-fast)' }}
          >
            {Icon ? <Icon aria-hidden className={segmentedIconVariants({ variant })} /> : null}
            <span className={segmentedLabelVariants({ variant })}>{option.label}</span>
            {option.count === undefined ? null : (
              <span className={segmentedCountVariants({ variant })} aria-hidden>{option.count}</span>
            )}
          </RadioGroupItem>
        );
      })}
    </RadioGroup>
  );
}
