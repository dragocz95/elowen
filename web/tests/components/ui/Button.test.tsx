import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Save } from 'lucide-react';
import { Button } from '../../../components/ui/Button';

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
    expect(button.className).toContain('bg-accent');
    expect(button.className).toContain('text-bg');
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
