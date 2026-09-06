import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Save } from 'lucide-react';
import { Button, buttonClassName } from '../../../components/ui/Button';
import { Button as ShadcnButton, buttonVariants } from '../../../components/ui/shadcn/button';

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

  /** The wrapper used to swallow the size axis: it passed `variant` down and nothing else, so every app
   *  button was the default height and a caller who wanted another one hand-wrote `h-8` into `className`.
   *  What is worth pinning is that the prop reaches the CVA — that the geometry comes from the declared
   *  size and not from the default plus an override. */
  it('forwards the size axis to the primitive', () => {
    render(<Button size="sm">Small</Button>);
    render(<Button size="lg">Large</Button>);
    render(<Button>Medium</Button>);

    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('h-8');
    expect(screen.getByRole('button', { name: 'Large' }).className).toContain('h-10');
    expect(screen.getByRole('button', { name: 'Medium' }).className).toContain('h-9');
  });

  it('lets className override the size it was given, rather than emitting both', () => {
    render(<Button size="lg" className="h-8">Squashed</Button>);
    const button = screen.getByRole('button', { name: 'Squashed' });
    expect(button.className).toContain('h-8');
    expect(button.className).not.toContain('h-10');
  });
});

describe('buttonClassName', () => {
  it('takes the same size axis, so a button-shaped <a> matches a real button', () => {
    expect(buttonClassName('default', 'sm')).toBe(
      render(<Button variant="default" size="sm" />).container.querySelector('button')!.className,
    );
  });

  it('defaults to the default size and keeps caller overrides last', () => {
    expect(buttonClassName()).toContain('h-9');
    expect(buttonClassName('accent', 'lg', 'w-full')).toContain('w-full');
    expect(buttonClassName('accent', 'lg', 'w-full')).toContain('h-10');
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

/** Depth PINS on the primary control. A value here changing is a design decision, not a refactor.
 *  Written against the shadcn variant names, because that is the axis the geometry is declared on — the
 *  app's `accent` is shadcn's `default`. */
describe('primary button depth', () => {
  it('rests the primary variant on the design\u2019s own ring token', () => {
    // A token rather than a baked shadow: the drop that reads on a near-white page is a no-op on a
    // true-black one, so each design states its own value and a white-label theme retints the ring by
    // moving --primary-rgb alone.
    expect(buttonVariants({ variant: 'default' })).toContain('shadow-[var(--shadow-primary)]');
    // …and the app vocabulary's name for the same button gets it too.
    expect(buttonClassName('accent')).toContain('shadow-[var(--shadow-primary)]');
  });

  it('gives that ring to the primary alone, so the quiet variants stay quiet', () => {
    for (const variant of ['secondary', 'outline', 'ghost', 'destructive'] as const) {
      expect(buttonVariants({ variant }), `${variant} took the primary ring`).not.toContain('--shadow-primary');
    }
  });

  it('transitions the ring with the fill, on the app\u2019s instant step', () => {
    const base = buttonVariants({ variant: 'default' });
    // Without box-shadow in the property list the ring snapped while the fill faded, which reads worse
    // than either alone. The duration is a token so reduced effects and `data-effects='off'` zero it.
    expect(base).toContain('box-shadow');
    expect(base).toContain('duration-[var(--motion-instant)]');
    expect(base).not.toContain('duration-150');
  });
});

/** The token has to EXIST in the vocabulary and be stated by every shipped design, or the utility above
 *  resolves to nothing and the button silently loses its edge on whichever design forgot it. */
describe('the primary ring token', () => {
  const read = (path: string) => readFileSync(join(resolve(process.cwd()), path), 'utf-8');

  it('is declared once in the vocabulary and restated by both designs', () => {
    expect(read('app/styles/tokens.css')).toMatch(/--shadow-primary:\s*[^;]+;/);
    for (const skin of ['studio-light', 'studio-oled']) {
      expect(read(`skins/${skin}/skin.css`), `${skin} does not state the primary ring`)
        .toMatch(/--shadow-primary:\s*[^;]+;/);
    }
  });

  it('composes the brand from --primary-rgb rather than baking a literal colour', () => {
    for (const path of ['app/styles/tokens.css', 'skins/studio-light/skin.css', 'skins/studio-oled/skin.css']) {
      const value = read(path).match(/--shadow-primary:\s*([^;]+);/)![1]!;
      expect(value, `${path} bakes a literal brand colour`).toContain('var(--primary-rgb)');
    }
  });
});
