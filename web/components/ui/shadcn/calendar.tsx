'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';
import { buttonVariants } from '../shadcn/button';

/** The shadcn/ui Calendar, on `react-day-picker`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attributes, its
 *  caption/nav/lattice structure and its `components`/`classNames` override surface are shadcn's,
 *  written for `react-day-picker` v9 (React 19 compatible). What is ours is only the styling, which
 *  reads this app's design tokens and the canonical shadcn Button variants (`button.tsx`) instead of
 *  shadcn's default palette.
 *
 *  No Radix Portal and no custom focus trap, like every other primitive here. A date grid renders in
 *  place inside whatever surface or overlay its caller composes it into; it is a native ARIA grid, and
 *  react-day-picker owns the keyboard handling for it (arrows move focus between days, Home/End within
 *  the week, PageUp/PageDown across months).
 *
 *  Everything a workspace needs is a plain prop: a controlled `month`, `selected`/`modifiers`,
 *  `components.DayContent` for custom day content, a `locale` object for the localized week labels,
 *  `hidden`/`disabled` for the window the caller plans around, and `numberOfMonths` when the caller
 *  wants the range view.
 *
 *  react-day-picker v9 semantics, relied on throughout: `day` styles the CELL that wraps each date and
 *  carries the state classes (`selected`, `today`, `outside`, `disabled`, `range_*`); `day_button`
 *  styles the `<button>` inside it. The state selectors below therefore style the button THROUGH its
 *  cell (`[&>button]:…`), which is also what lets a selected day override the ghost day-button classes
 *  deterministically. */

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  captionLayout = 'label',
  buttonVariant = 'ghost',
  formatters,
  components,
  ...props
}: React.ComponentProps<typeof DayPicker> & {
  /** The canonical shadcn Button variant the nav chevrons and dropdown triggers wear. */
  buttonVariant?: VariantProps<typeof buttonVariants>['variant'];
}) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('group/calendar bg-popover p-3 [--cell-size:2rem] text-popover-foreground', className)}
      captionLayout={captionLayout}
      formatters={{
        formatMonthDropdown: (date) => date.toLocaleString('default', { month: 'short' }),
        ...formatters,
      }}
      classNames={{
        months: 'relative flex flex-col gap-4 sm:flex-row sm:gap-2',
        month: 'relative flex w-full flex-col gap-4',
        nav: 'absolute inset-x-0 top-0 flex h-7 w-full items-center justify-between gap-1',
        button_previous: cn(buttonVariants({ variant: buttonVariant, size: 'sm' }), 'size-7 select-none p-0'),
        button_next: cn(buttonVariants({ variant: buttonVariant, size: 'sm' }), 'size-7 select-none p-0'),
        month_caption: 'flex h-7 w-full items-center justify-center px-8',
        dropdowns: 'flex h-7 w-full items-center justify-center gap-1 text-sm font-medium',
        dropdown: 'rounded-md bg-popover px-1 py-1 text-sm font-medium outline-none',
        caption_label: captionLayout === 'label'
          ? 'select-none text-sm font-medium'
          : 'flex h-7 select-none items-center gap-1 rounded-md pl-2 pr-1 text-sm font-medium outline-none',
        weekdays: 'flex',
        weekday: 'w-8 select-none px-1 text-[0.8rem] font-normal text-muted-foreground',
        week: 'mt-2 flex w-full',
        week_number_header: 'w-(--cell-size)',
        week_number: 'select-none text-[0.8rem] text-muted-foreground',
        day: 'relative aspect-square h-full w-full select-none p-0 text-center group/day',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'size-8 cursor-pointer p-0 font-normal leading-none',
          // Touch first: a date is a one-hand target, and a 32px day button is the smallest tap the
          // month grid may ask for. On a coarse pointer the day cell grows to the 44px floor every
          // plugin surface is held to; on a fine pointer the compact grid keeps its density.
          '[@media(pointer:coarse)]:size-11',
        ),
        // Range chrome stays: a caller composing a range selects `modifiers='range'` and the
        // endpoints plus the middle read as one connected band through the same cell grid.
        range_start: '[&>button]:rounded-l-md',
        range_end: '[&>button]:rounded-r-md',
        range_middle: '[&>button]:rounded-none',
        selected: '[&>button]:bg-primary [&>button]:text-primary-foreground [&>button]:hover:bg-primary/90',
        today: '[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-accent-foreground',
        outside: 'text-muted-foreground [&>button]:text-muted-foreground',
        disabled: 'cursor-not-allowed text-muted-foreground [&>button]:cursor-not-allowed [&>button]:text-muted-foreground',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        /** The library's default root is a plain div already; this stands in only to carry shadcn's
         *  `data-slot` marker, so outward CSS (a plugin's, or a skin's) can reach the grid without the
         *  `classNames` API. */
        Root: ({ className, rootRef, ...props }) => (
          <div data-slot="calendar" ref={rootRef} className={cn(className)} {...props} />
        ),
        Chevron: ({ className, orientation }) => {
          if (orientation === 'left') return <ChevronLeft className={cn('size-4', className)} />;
          if (orientation === 'right') return <ChevronRight className={cn('size-4', className)} />;
          if (orientation === 'up') return <ChevronDown className={cn('size-4 rotate-180', className)} />;
          return <ChevronDown className={cn('size-4', className)} />;
        },
        ...components,
      }}
      {...props}
    />
  );
}

export { Calendar };
