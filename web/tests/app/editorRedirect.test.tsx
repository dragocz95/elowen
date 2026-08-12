import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

import EditorPage from '../../app/editor/page';

describe('legacy editor page', () => {
  it('replaces the historical route with the editor plugin host', () => {
    render(<EditorPage />);
    expect(replace).toHaveBeenCalledWith('/p/editor');
  });
});
