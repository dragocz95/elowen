import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LayoutDashboard } from 'lucide-react';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { createWrapper } from '../test-utils';

afterEach(() => { document.title = ''; localStorage.clear(); });

const renderHeader = (ui: React.ReactElement) => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper>{ui}</Wrapper>);
};

describe('ModuleHeader — per-page document title (the single funnel)', () => {
  it('titles the tab while mounted and hands the tab back to the layout on unmount', () => {
    // The layout always renders a title of its own (Next metadata). Stand it up here so the fallback is
    // the real one: unmounting must drop back to it, not blank the tab.
    const layoutTitle = document.createElement('title');
    layoutTitle.textContent = 'Elowen';
    document.head.appendChild(layoutTitle);
    try {
      const { unmount } = renderHeader(<ModuleHeader title="Dashboard" icon={LayoutDashboard}><button>x</button></ModuleHeader>);
      expect(document.title).toBe('Elowen — Dashboard');
      unmount();
      expect(document.title).toBe('Elowen');
    } finally {
      layoutTitle.remove();
    }
  });

  it('leaves no title of its own behind — the node belongs to React, not to a write', () => {
    // The imperative write lost the race against React's own commit of the <title> node: measured on
    // /projects, the effect set the page title and React put the bare app name back afterwards, so core
    // pages ended up untitled while plugin pages kept theirs only because their bundle lands later.
    // Guard the mechanism: a title React renders is removed with the component, where a written one
    // outlives it and leaves the tab claiming a page that is gone.
    const before = document.head.querySelectorAll('title').length;
    const { unmount } = renderHeader(<ModuleHeader title="Memory" />);
    expect(document.head.querySelectorAll('title').length).toBe(before + 1);
    unmount();
    expect(document.head.querySelectorAll('title').length).toBe(before);
  });

  it('still updates the title on a bare title-only page (no children/subtitle → component renders nothing)', () => {
    // The effect runs before ModuleHeader's early `return null`, so title-only routes (e.g. /dash) still
    // get their tab title even though the component itself renders no toolbar.
    const { container } = renderHeader(<ModuleHeader title="Statistics" />);
    expect(container.firstChild).toBeNull();       // nothing rendered
    expect(document.title).toBe('Elowen — Statistics');
  });

  it('reflects the active locale — a Czech page title yields "Elowen — Přehled"', () => {
    localStorage.setItem('elowen-locale', 'cs');
    renderHeader(<ModuleHeader title="Přehled"><button>x</button></ModuleHeader>);
    expect(document.title).toBe('Elowen — Přehled');
  });
});

describe('ModuleHeader — responsive toolbar', () => {
  it('wraps complete filter/action groups without introducing a horizontal scroller', () => {
    renderHeader(
      <ModuleHeader title="Tasks">
        <button data-testid="ctrl">a</button>
      </ModuleHeader>,
    );
    const row = screen.getByTestId('ctrl').parentElement!;
    expect(row.className).toContain('flex-wrap');
    expect(row.className).toContain('justify-end');
    expect(row.className).toContain('[&>*]:max-w-full');
    expect(row.className).not.toContain('flex-nowrap');
    expect(row.className).not.toContain('overflow-x-auto');
  });
});
