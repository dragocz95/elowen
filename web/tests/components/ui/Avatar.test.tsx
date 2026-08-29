import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar, identityHueOf } from '../../../components/ui/Avatar';

/** The monogram's identity ramp. It used to be eight hex literals; it is now eight hue rotations of the
 *  brand primary, so a skin repaints it. What must survive that change is the PROPERTY the palette
 *  existed for — a person's chip is stable and their neighbours' chips are different — which nothing
 *  else in the suite pins. */
describe('Avatar identity ramp', () => {
  it('gives one label the same hue every time', () => {
    expect(identityHueOf('Filip Džudža')).toBe(identityHueOf('Filip Džudža'));
    expect(identityHueOf('alex')).toBe(identityHueOf('alex'));
  });

  it('spreads the eight buckets evenly around the wheel and uses all of them', () => {
    // Every bucket is reachable, and no two are the same angle — otherwise two people who hash apart
    // would still be painted identically, which is the whole failure the ramp exists to avoid.
    const hues = new Set(Array.from({ length: 64 }, (_, i) => identityHueOf('a'.repeat(i))));
    expect([...hues].sort((a, b) => a - b)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
  });

  it('paints the monogram with the brand fill rotated to the label\'s hue', () => {
    render(<Avatar user={{ id: 1, username: 'alex', name: 'Alex Rivera' }} />);
    const fallback = screen.getByText('AR');
    expect(fallback).toHaveClass('bg-primary', 'text-primary-foreground');
    expect(fallback).toHaveStyle({ filter: `hue-rotate(${identityHueOf('Alex Rivera')}deg)` });
  });
});
