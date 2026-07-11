import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RouteTransition } from '../../../components/shell/RouteTransition';
import { createWrapper } from '../../test-utils';

const navigation = vi.hoisted(() => ({ pathname: '/projects' }));
vi.mock('next/navigation', () => ({ usePathname: () => navigation.pathname }));

describe('RouteTransition', () => {
  it('mounts the incoming route immediately so a slow or repeated navigation cannot leave a blank frame', () => {
    const { wrapper: Wrapper } = createWrapper();
    const view = render(<Wrapper><RouteTransition><span>projects-content</span></RouteTransition></Wrapper>);
    expect(screen.getByText('projects-content')).toBeInTheDocument();

    navigation.pathname = '/memory';
    view.rerender(<Wrapper><RouteTransition><span>memory-content</span></RouteTransition></Wrapper>);
    expect(screen.getByText('memory-content')).toBeInTheDocument();
    // During the crossfade both layers share one grid area: the old surface remains visible while the
    // new surface is already mounted, so even another immediate navigation has no empty interval.
    expect(screen.getAllByTestId('route-transition')).toHaveLength(2);

    navigation.pathname = '/projects';
    view.rerender(<Wrapper><RouteTransition><span>projects-returned</span></RouteTransition></Wrapper>);
    // Returning before the first /projects layer has finished exiting creates a fresh keyed layer;
    // the current page can never inherit the old layer's opacity: 0 exit animation.
    expect(screen.getByText('projects-returned')).toBeInTheDocument();
    expect(screen.getAllByTestId('route-transition')).toHaveLength(3);
  });
});
