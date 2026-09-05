'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';
import { useMobile } from '../../../lib/useMobile';
import { Skeleton } from './skeleton';

/** The shadcn/ui Sidebar primitive, adopted with two deliberate deviations from upstream. Both exist
 *  because this app already owns the two things upstream's `Sidebar` wrapper tries to own:
 *
 *  1. NO SHEET. Upstream swaps the whole column for `<Sheet>` below the mobile breakpoint, which is a
 *     portalled Radix Dialog. This app isolates an open overlay's background by marking every other
 *     child of <body> inert (`components/ui/overlayStack.ts`), so a portalled panel lands outside the
 *     dialog it belongs to. The app's drawer presentation is `dialog.tsx`'s `presentation="sheet"` and
 *     the shell already mounts it; the primitive therefore renders the same tree at every width and
 *     reports `isMobile` so a caller can choose. Re-running `shadcn add sidebar` will put the Sheet
 *     back — that is the branch to remove again.
 *
 *  2. `Sidebar` TAKES `asChild`. Upstream renders its own fixed-position column plus a width spacer.
 *     The shell here lays the column out itself (`.shell-workspace` is a flex row) and the Studio skin
 *     owns every dimension of it, so the wrapper would be a second, disagreeing layout owner. With
 *     `asChild` the caller hands it the element it already has and keeps the state contract — the
 *     `data-state` / `data-collapsible` / `data-side` attributes every part below reads.
 *
 *  Everything else is upstream: the same part names, the same `data-slot`/`data-sidebar` attributes,
 *  the same CVA axes on the menu button, so a component copied from the shadcn docs drops in. */

const SIDEBAR_WIDTH_ICON = '3rem';

type SidebarState = 'expanded' | 'collapsed';

type SidebarContextValue = {
  state: SidebarState;
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

/** The column's state. Returns `null` outside a provider rather than throwing, unlike upstream: the
 *  parts below are mounted by a navigation component that several suites render on its own, and a
 *  primitive that throws would turn "no provider in this test" into a failing render instead of a
 *  column that simply reports itself expanded. */
function useSidebar(): SidebarContextValue | null {
  return React.useContext(SidebarContext);
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useMobile();
  const [uncontrolled, setUncontrolled] = React.useState(defaultOpen);
  const open = openProp ?? uncontrolled;

  const setOpen = React.useCallback((next: boolean) => {
    if (openProp === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  }, [onOpenChange, openProp]);

  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({ state: open ? 'expanded' : 'collapsed', open, setOpen, isMobile, toggleSidebar }),
    [isMobile, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{ '--sidebar-width-icon': SIDEBAR_WIDTH_ICON, ...style } as React.CSSProperties}
        className={cn('contents', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

/** The column itself. With `asChild` the caller's element receives the state attributes; without it the
 *  primitive renders a plain flex column, which is what a surface with no layout of its own wants. */
function Sidebar({
  side = 'left',
  collapsible = 'icon',
  asChild = false,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right';
  collapsible?: 'offcanvas' | 'icon' | 'none';
  asChild?: boolean;
}) {
  const sidebar = useSidebar();
  const state = sidebar?.state ?? 'expanded';
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-slot="sidebar"
      data-sidebar="sidebar"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-side={side}
      className={cn('flex h-full flex-col', asChild ? undefined : 'bg-sidebar text-sidebar-foreground', className)}
      {...props}
    />
  );
}

/** The hit strip on the column's inner edge. It is the affordance Linear and Vercel both use: a 4px
 *  invisible target the whole height of the column that folds it, so the fold is reachable without the
 *  reader hunting for a chevron. It renders nothing outside a provider — there is no state to toggle. */
function SidebarRail({ className, ...props }: React.ComponentProps<'button'>) {
  const sidebar = useSidebar();
  if (!sidebar) return null;
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      data-sidebar="rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={sidebar.toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        'absolute inset-y-0 z-20 hidden w-1 -translate-x-1/2 transition-colors ease-linear',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border',
        'in-data-[side=left]:right-0 in-data-[side=right]:left-0 sm:flex',
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-header" data-sidebar="header" className={cn('flex flex-col gap-2', className)} {...props} />;
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-footer" data-sidebar="footer" className={cn('flex flex-col gap-2', className)} {...props} />;
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-auto', className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-group" data-sidebar="group" className={cn('relative flex w-full min-w-0 flex-col', className)} {...props} />;
}

function SidebarGroupLabel({ className, asChild = false, ...props }: React.ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn('flex shrink-0 items-center', className)}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn('w-full min-w-0', className)} {...props} />;
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn('flex w-full min-w-0 flex-col', className)} {...props} />;
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn('group/menu-item relative', className)} {...props} />;
}

/** The row. The CVA axes are upstream's, and they are what a caller copied from the shadcn docs sets;
 *  in the Studio skin the painted result comes from the skin's own `.studio-nav__item` rule, which
 *  out-specifies a utility class by construction (the skin tree is unlayered). */
const sidebarMenuButtonVariants = cva(
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden text-left outline-hidden transition-[width,height,padding] disabled:pointer-events-none disabled:opacity-50 [&>svg]:shrink-0 data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline: 'bg-background hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant,
  size,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean;
  isActive?: boolean;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size ?? 'default'}
      // `|| undefined` and not `{isActive}`: the app's skin selects on the bare attribute
      // (`[data-active]`), which `data-active="false"` would satisfy — every row would paint active.
      data-active={isActive || undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/** A count riding on a row — running agents, unread. Not a control: it is `aria-hidden` by default at
 *  the call site, because the number is already in the row's accessible name where it matters. */
function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn('pointer-events-none select-none tabular-nums', className)}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({ className, showIcon = false, ...props }: React.ComponentProps<'div'> & { showIcon?: boolean }) {
  // Upstream randomises the width per row so a loading list does not read as a bar chart. The value is
  // computed once per mount rather than per render, or every parent commit reshuffles the placeholders.
  const width = React.useMemo(() => `${Math.floor(Math.random() * 40) + 50}%`, []);
  return (
    <div data-slot="sidebar-menu-skeleton" data-sidebar="menu-skeleton" className={cn('flex h-8 items-center gap-2 px-2', className)} {...props}>
      {showIcon ? <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" /> : null}
      <Skeleton className="h-4 max-w-(--skeleton-width) flex-1" data-sidebar="menu-skeleton-text" style={{ '--skeleton-width': width } as React.CSSProperties} />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>) {
  return <ul data-slot="sidebar-menu-sub" data-sidebar="menu-sub" className={cn('flex min-w-0 flex-col', className)} {...props} />;
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="sidebar-menu-sub-item" data-sidebar="menu-sub-item" className={cn('group/menu-sub-item relative', className)} {...props} />;
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  useSidebar,
};
