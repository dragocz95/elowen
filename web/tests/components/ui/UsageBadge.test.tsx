import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageBadge } from '../../../components/ui/UsageBadge';
import { createWrapper } from '../../test-utils';
import type { TokenUsage } from '../../../lib/types';

describe('UsageBadge', () => {
  it('renders nothing when usage is null', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><UsageBadge usage={null as unknown as TokenUsage} /></Wrapper>);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when total is 0', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><UsageBadge usage={{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: null }} /></Wrapper>);
    expect(container.innerHTML).toBe('');
  });

  it('renders IN and OUT pills with formatted counts', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UsageBadge usage={{ input: 1500, output: 500, cacheRead: 0, cacheWrite: 0, total: 2000, costUsd: null }} /></Wrapper>);
    expect(screen.getByText('1.5k')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
  });

  it('shows CACHE pill when cache is present', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><UsageBadge usage={{ input: 5000, output: 1000, cacheRead: 3000, cacheWrite: 0, total: 6000, costUsd: null }} /></Wrapper>);
    expect(container.textContent).toContain('3.0k');
    expect(container.textContent).toContain('cache');
  });

  it('renders the cache pill in the blue info tone', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><UsageBadge usage={{ input: 5000, output: 1000, cacheRead: 3000, cacheWrite: 0, total: 6000, costUsd: null }} /></Wrapper>);
    // The inner label span reads exactly "cache"; its parent is the styled pill.
    const label = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'cache');
    const pill = label?.parentElement;
    expect(pill?.className).toContain('text-info');
  });

  it('renders an icon in every pill', () => {
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><UsageBadge usage={{ input: 5000, output: 1000, cacheRead: 3000, cacheWrite: 0, total: 6000, costUsd: null }} /></Wrapper>);
    // input + cache + output → three lucide svg icons.
    expect(container.querySelectorAll('svg').length).toBe(3);
  });

  it('shows cost in tooltip when available and positive', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><UsageBadge usage={{ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, costUsd: 0.01234 }} /></Wrapper>);
    const badge = screen.getByTitle(/cost/i);
    expect(badge).toBeInTheDocument();
    expect(badge.title).toContain('0.0123');
  });
});
