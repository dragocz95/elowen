import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Save } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { Button as ShadcnButton } from '../../../components/ui/shadcn/button';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Engage</Button>);
    const btn = screen.getByRole('button', { name: 'Engage' });
    btn.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
  it('applies the accent variant class', () => {
    render(<Button variant="accent">Go</Button>);
    const button = screen.getByRole('button', { name: 'Go' });
    expect(button.className).toContain('bg-primary');
    // The ink that PAIRS with that fill, never a literal: `text-primary-foreground` is what a skin moves
    // when it repaints the brand, and `text-white` is what stays white on a design that does not.
    expect(button.className).toContain('text-primary-foreground');
    expect(button.className).not.toContain('text-white');
  });
  it('renders children', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
  });
  it('renders an optional leading icon', () => {
    const { container } = render(<Button icon={Save}>Save</Button>);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});

/** `asChild` is the one capability the port ADDS, and it is the reason the app has a `buttonClassName`
 *  export at all: two places needed a button-shaped link and had to reach for the class string because
 *  the component could only ever be a `<button>`. A link that renders as a `<button>` is not a link —
 *  it has no href, so it cannot be opened in a new tab, copied, or followed without JavaScript — so what
 *  is worth pinning is that the element really changes, not that the classes come along with it. */
describe('shadcn Button', () => {
  it('renders as the child element under asChild, keeping the button styling', () => {
    render(
      <ShadcnButton asChild variant="secondary">
        <a href="/settings">Settings</a>
      </ShadcnButton>,
    );

    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveAttribute('data-slot', 'button');
    expect(link.className).toContain('bg-secondary');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
