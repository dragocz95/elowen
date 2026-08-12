import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const replace = vi.fn();
const search = vi.hoisted(() => ({ value: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

import EditorPage from '../../app/editor/page';

beforeEach(() => { replace.mockClear(); search.value = ''; });

describe('legacy editor page', () => {
  it('replaces the historical route with the editor plugin host', () => {
    render(<EditorPage />);
    expect(replace).toHaveBeenCalledWith('/p/editor');
  });

  // The editor page opens one project — and optionally one commit or the working tree — from the query
  // string. A redirect that dropped it would land every bookmarked deep link on the remembered filter
  // instead of the revision someone saved the URL for.
  it('carries a deep link’s query string across the redirect', () => {
    search.value = 'project=3&commit=c6e8c59b';
    render(<EditorPage />);
    expect(replace).toHaveBeenCalledWith('/p/editor?project=3&commit=c6e8c59b');
  });
});
