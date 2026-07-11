import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TerminalWindow from '../../app/terminal/[name]/page';
import { createWrapper } from '../test-utils';

vi.mock('next/navigation', () => ({ useParams: () => ({ name: 'elowen-advisor-1' }) }));
vi.mock('../../components/terminal/StreamTerminal', () => ({
  StreamTerminal: ({ name }: { name: string }) => <div data-testid="stream">{name}</div>,
}));

describe('TerminalWindow (pop-out route)', () => {
  it('renders a chromeless terminal for the routed session', async () => {
    // Chromeless, but still inside the app's providers (it reads the app name via i18n for the tab title).
    const { wrapper: Wrapper } = createWrapper();
    const { container } = render(<Wrapper><TerminalWindow /></Wrapper>);
    expect((await screen.findByTestId('stream')).textContent).toBe('elowen-advisor-1'); // dynamic, ssr:false
    expect(screen.getByText('advisor-1')).toBeTruthy(); // header shows the friendly name
    expect(document.title).toBe('Elowen — advisor-1'); // per-page tab title
    expect(container.firstElementChild).toHaveClass('h-dvh', 'bg-bg');
    expect(container.querySelector('.bg-surface')).not.toBeNull();
    expect(container.querySelector('[data-control-surface]')).toBeNull();
    expect(container.querySelector('.spatial-mascot')).toBeNull();
  });
});
