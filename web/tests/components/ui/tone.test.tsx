import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Badge } from '../../../components/ui/Badge';

describe('Tone on primitives', () => {
  it('Badge renders a danger tone', () => {
    const { getByText } = render(<Badge tone="danger">blocked</Badge>);
    // The app's `danger` tone paints from the shadcn `destructive` token — the palette was renamed, the
    // tone was not.
    expect(getByText('blocked').className).toContain('destructive');
  });
});
