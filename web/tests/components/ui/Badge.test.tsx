import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../../../components/ui/Badge';

describe('Badge', () => {
  it('Badge renders mono label', () => {
    render(<Badge>working</Badge>);
    expect(screen.getByText('working')).toHaveClass('font-mono');
  });

  it('gives the quiet tone less emphasis than the ordinary one', () => {
    // Both tones resolved to the shadcn `secondary` variant, so `tone="muted"` produced a chip identical
    // to the default one: a caller asking for less emphasis got exactly the same paint, and the tone
    // documented an intention the UI never carried out.
    render(<><Badge>plugin id</Badge><Badge tone="muted">source</Badge></>);
    const ordinary = screen.getByText('plugin id').className;
    const quiet = screen.getByText('source').className;

    expect(ordinary).not.toBe(quiet);
    // The direction of the difference is the point: the quiet one keeps the muted ink, the ordinary one
    // reads at full strength. A distinction that made `muted` the louder chip would pass a bare !== check.
    expect(quiet).toContain('text-muted-foreground');
    expect(ordinary).toContain('text-foreground');
    expect(ordinary).not.toContain('text-muted-foreground');
  });
});
