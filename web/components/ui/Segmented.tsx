'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { cva } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/utils';
import { consumeHorizontalWheel, horizontalOverflowState, NO_HORIZONTAL_OVERFLOW, revealHorizontalItem, type HorizontalOverflowState } from './horizontalScroll';
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

/** Every presentation of the label is bounded and truncating. A section list is not always written by this
 *  repository — a plugin contributes Account and Settings entries — so an over-long label must cost a
 *  clipped word and a tooltip, never a rail stretched past its column or a tab row that scrolls forever. */
const segmentedLabelVariants = cva('', {
  variants: {
    variant: {
      default: 'min-w-0 max-w-[14rem] truncate',
      line: 'min-w-0 max-w-[14rem] truncate',
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
  /** Keep the track on one line. The track scrolls horizontally when it runs out of room, keeps the active
   *  option visible and exposes measured edge state so the stylesheet only paints a fade when content is
   *  genuinely hidden on that side. */
  nowrap?: boolean;
  /** Accessible name for the radiogroup — pass it when the control acts as a labelled section nav. */
  'aria-label'?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [overflowState, setOverflowState] = useState<HorizontalOverflowState>(NO_HORIZONTAL_OVERFLOW);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const optionContentKey = options.map((option) => `${option.value}\u0000${option.label}\u0000${option.count ?? ''}`).join('\u0001');
  const orientation = variant === 'menu' ? 'vertical' : 'horizontal';
  const radioSize = size === 'sm' ? 'sm' : 'default';

  const measureOverflow = useCallback(() => {
    const track = trackRef.current;
    if (!track || !nowrap) {
      setOverflowState((current) => current === NO_HORIZONTAL_OVERFLOW ? current : NO_HORIZONTAL_OVERFLOW);
      return;
    }

    const next = horizontalOverflowState(track);
    setOverflowState((current) => (
      current.overflow === next.overflow && current.left === next.left && current.right === next.right
        ? current
        : next
    ));
  }, [nowrap]);

  const revealSelected = useCallback(() => {
    const track = trackRef.current;
    const item = selectedIndex < 0 ? null : itemRefs.current[selectedIndex];
    if (!track || !item || !nowrap) return;
    revealHorizontalItem(track, item);
    measureOverflow();
  }, [measureOverflow, nowrap, selectedIndex]);

  useEffect(() => {
    if (!nowrap || selectedIndex < 0) return;
    revealSelected();
  }, [nowrap, optionContentKey, revealSelected, selectedIndex]);

  const onWheel = useCallback((event: globalThis.WheelEvent) => {
    const track = trackRef.current;
    if (!track || !nowrap) return;
    if (consumeHorizontalWheel(track, event)) measureOverflow();
  }, [measureOverflow, nowrap]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track || !nowrap) return;

    measureOverflow();
    const resizeObserver = new ResizeObserver(() => {
      revealSelected();
      measureOverflow();
    });
    const mutationObserver = new MutationObserver(() => {
      revealSelected();
      measureOverflow();
    });
    resizeObserver.observe(track);
    mutationObserver.observe(track, { characterData: true, subtree: true });
    track.addEventListener('scroll', measureOverflow, { passive: true });
    // React registers wheel handlers passively at the root. This listener must be explicitly non-passive
    // so vertical page scrolling is blocked only after the horizontal track really moves.
    track.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      track.removeEventListener('scroll', measureOverflow);
      track.removeEventListener('wheel', onWheel);
    };
  }, [measureOverflow, nowrap, onWheel, revealSelected]);

  const edgeStyle = {
    '--segmented-edge-fade-left': overflowState.left ? 'var(--segmented-edge-fade-size)' : '0px',
    '--segmented-edge-fade-right': overflowState.right ? 'var(--segmented-edge-fade-size)' : '0px',
  } as CSSProperties;

  return (
    // `segmented` / `segmented__option` / `segmented__count` are named for the same reason the toolbar
    // and the field are: this control is one of the handful a DESIGN has to be able to restate, and a
    // stylesheet has nothing to hold on to otherwise. The utilities below stay the built-in reading.
    <RadioGroup
      ref={trackRef}
      value={value}
      onValueChange={onChange}
      aria-label={ariaLabel}
      aria-orientation={orientation}
      variant={variant}
      nowrap={nowrap}
      data-nowrap={nowrap ? 'true' : undefined}
      data-overflow={nowrap ? String(overflowState.overflow) : undefined}
      data-overflow-left={nowrap ? String(overflowState.left) : undefined}
      data-overflow-right={nowrap ? String(overflowState.right) : undefined}
      style={edgeStyle}
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
            {/* The native tooltip is what makes the truncation lossless: whatever is clipped stays
                readable on hover, and the accessible name above already carries the full text. */}
            <span title={option.label} className={segmentedLabelVariants({ variant })}>{option.label}</span>
            {option.count === undefined ? null : (
              <span className={segmentedCountVariants({ variant })} aria-hidden>{option.count}</span>
            )}
          </RadioGroupItem>
        );
      })}
    </RadioGroup>
  );
}
