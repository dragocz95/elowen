import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from '../../../../components/ui/shadcn/sidebar';

/** The Sidebar primitive's own contract, tested away from the navigation that consumes it.
 *
 *  What matters here is the part of the primitive the app depends on and upstream could change under it:
 *  the `data-sidebar` / `data-slot` attribute names a skin selects on, the fold state reaching every part
 *  through context, and the two deliberate deviations from upstream — no Sheet and no portal — which are
 *  the reason this file is a port rather than a `shadcn add`. A test that only rendered rows would pass
 *  just as happily with any of that missing. */

/** The primitive under a provider, with a row, a sub-row and a fold control. */
function Column({ open, onOpenChange }: { open?: boolean; onOpenChange?: (next: boolean) => void } = {}) {
  return (
    <SidebarProvider open={open} onOpenChange={onOpenChange}>
      <Sidebar asChild>
        <nav data-shell="sidebar" aria-label="Primary">
          <SidebarHeader>Instance</SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Work</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton isActive>Chat</SidebarMenuButton>
                    <SidebarMenuSub>
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton href="/chat/history">History</SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton>Projects</SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
          </SidebarContent>
          <SidebarFooter>
            <SidebarTrigger aria-label="Toggle sidebar" />
          </SidebarFooter>
        </nav>
      </Sidebar>
    </SidebarProvider>
  );
}

describe('Sidebar primitive', () => {
  it('renders as the caller\'s own element and keeps the shell and skin hooks on it', () => {
    render(<Column />);
    // `asChild` is the deviation that lets the shell own the column's layout: the primitive must hand its
    // state attributes to the <nav> rather than wrap it in a div of its own. A wrapper would put an
    // element between the nav landmark and the flex row that positions it.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toHaveAttribute('data-sidebar', 'sidebar');
    expect(nav).toHaveAttribute('data-slot', 'sidebar');
    expect(nav).toHaveAttribute('data-shell', 'sidebar');
    expect(nav).toHaveAttribute('data-state', 'expanded');
  });

  it('names every part with the data-sidebar attribute a skin selects on', () => {
    const { container } = render(<Column />);
    // These strings are the styling contract. A rename upstream would leave the app's skin matching
    // nothing, which paints an unstyled column and fails no type check.
    for (const part of ['header', 'content', 'group', 'group-label', 'group-content', 'menu', 'menu-item', 'menu-button', 'menu-sub', 'menu-sub-item', 'menu-sub-button', 'separator', 'footer', 'trigger']) {
      expect(container.querySelector(`[data-sidebar="${part}"]`), `no element carries data-sidebar="${part}"`).not.toBeNull();
    }
  });

  it('marks only the active row, and marks it by the bare attribute', () => {
    const { container } = render(<Column />);
    // `data-active="false"` would satisfy the skin's `[data-active]` selector and paint every row active,
    // so an inactive row must carry no attribute at all rather than a falsy one.
    const rows = [...container.querySelectorAll('[data-sidebar="menu-button"]')];
    expect(rows.map((row) => row.getAttribute('data-active'))).toEqual(['true', null]);
  });

  it('reports the fold through context so every part sees one state', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<Column open onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole('button', { name: 'Toggle sidebar' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(trigger);
    // Controlled: the primitive asks, the owner decides. It must NOT also fold itself, or the shell's
    // state and the column's disagree the moment the shell declines.
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toHaveAttribute('data-state', 'expanded');

    rerender(<Column open={false} onOpenChange={onOpenChange} />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toHaveAttribute('data-state', 'collapsed');
    expect(nav).toHaveAttribute('data-collapsible', 'icon');
    expect(screen.getByRole('button', { name: 'Toggle sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders every part in place, with nothing portalled out of the column', () => {
    const { container } = render(<Column />);
    // The repo's overlay stack marks every other child of <body> inert while a modal is open, so a
    // portalled sidebar part would land outside the dialog it belongs to and go unreachable in the
    // drawer presentation. Everything the primitive renders must therefore be inside the caller's tree.
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const part of container.querySelectorAll('[data-sidebar]')) {
      expect(nav.contains(part) || part === nav, `${part.getAttribute('data-sidebar')} escaped the column`).toBe(true);
    }
    // Upstream swaps the whole column for a portalled Radix Dialog below the mobile breakpoint. Nothing
    // in this port may reintroduce that: no dialog role, and no stray body child beside the container.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.children).toHaveLength(1);
  });

  it('renders the parts outside a provider instead of throwing', () => {
    // Several suites mount the navigation on its own. Upstream's `useSidebar` throws without a provider,
    // which would turn "no provider in this test" into a failed render rather than an expanded column.
    render(
      <Sidebar asChild>
        <nav aria-label="Bare">
          <SidebarMenu><SidebarMenuItem><SidebarMenuButton>Chat</SidebarMenuButton></SidebarMenuItem></SidebarMenu>
          <SidebarTrigger aria-label="Toggle sidebar" />
        </nav>
      </Sidebar>,
    );
    const nav = screen.getByRole('navigation', { name: 'Bare' });
    expect(nav).toHaveAttribute('data-state', 'expanded');
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    // The fold control has no state to toggle there, so it renders nothing rather than a dead button.
    expect(screen.queryByRole('button', { name: 'Toggle sidebar' })).toBeNull();
  });
});
