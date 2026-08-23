import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { PageHeaderProvider, usePageHeader } from '../../lib/pageHeader';
import { createWrapper } from '../test-utils';

afterEach(() => { document.title = ''; localStorage.clear(); });

const renderHeader = (ui: React.ReactElement) => {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper>{ui}</Wrapper>);
};

/** Stands in for the shell's masthead — and, through it, for the browser tab: the shell's DocumentTitle
 *  reads the very same published header for a page the navigation names nowhere. */
function MastheadProbe() {
  return <div data-testid="masthead">{usePageHeader()?.header.title ?? ''}</div>;
}

/** Renders `ui` under one masthead that survives `swap` — the provider must not remount, or a withdrawn
 *  header would be indistinguishable from a fresh one. */
const renderPublished = (ui: ReactNode) => {
  const { wrapper: Wrapper } = createWrapper();
  const tree = (node: ReactNode) => (
    <Wrapper><PageHeaderProvider>{node}<MastheadProbe /></PageHeaderProvider></Wrapper>
  );
  const view = render(tree(ui));
  return { ...view, swap: (node: ReactNode) => view.rerender(tree(node)) };
};

describe('ModuleHeader — publishing the page name', () => {
  it('publishes the page name even when it renders no toolbar of its own', () => {
    // A title-only route (e.g. /dash) renders nothing here, but the name it publishes is what the
    // masthead shows and what the tab falls back to — so the publish must not ride on the markup.
    renderPublished(<ModuleHeader title="Statistics" />);
    expect(screen.getByTestId('masthead')).toHaveTextContent('Statistics');
  });

  it('withdraws the page name when the page unmounts', () => {
    const { swap } = renderPublished(<ModuleHeader title="Memory" />);
    expect(screen.getByTestId('masthead')).toHaveTextContent('Memory');
    swap(null);
    expect(screen.getByTestId('masthead')).toBeEmptyDOMElement();
  });

  // The tab is named once by the shell (components/shell/DocumentTitle) off the navigation model, so
  // every route is titled by one rule — including the plugin pages that never mount this component. A
  // second <title> here would put two title nodes in the head and let insertion order decide the tab.
  it('renders no <title> of its own', () => {
    const before = document.head.querySelectorAll('title').length;
    renderHeader(<ModuleHeader title="Memory" />);
    expect(document.head.querySelectorAll('title').length).toBe(before);
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
