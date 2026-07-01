import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SignalsRow } from '../../../modules/dashboard/SignalsRow';
import { createWrapper } from '../../test-utils';

describe('SignalsRow', () => {
  it('renders the three signals with their values and labels', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><SignalsRow agentsActive={2} decisionsWaiting={1} monthCost="$3.5000" /></Wrapper>);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('Agents active')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('Decisions waiting')).toBeTruthy();
    expect(screen.getByText('$3.5000')).toBeTruthy();
    expect(screen.getByText('Cost (month)')).toBeTruthy();
  });

  it('links the decisions signal to the escalations inbox when any are waiting', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><SignalsRow agentsActive={0} decisionsWaiting={3} monthCost="$0.0000" /></Wrapper>);
    const link = screen.getByText('Decisions waiting').closest('a');
    expect(link?.getAttribute('href')).toBe('/escalations');
  });

  it('does not link the decisions signal at zero', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><SignalsRow agentsActive={0} decisionsWaiting={0} monthCost="$0.0000" /></Wrapper>);
    expect(screen.getByText('Decisions waiting').closest('a')).toBeNull();
  });
});
