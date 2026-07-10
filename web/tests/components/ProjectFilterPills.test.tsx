import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }), useSearchParams: () => new URLSearchParams() }));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../msw';
import { ProjectFilterPills } from '../../components/ui/ProjectFilterPills';
import { createWrapper } from '../test-utils';

// 8 projects → the tail past the 5-pill preview folds behind "+N more".
const PROJECTS = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, slug: `proj-${i + 1}`, path: `/repo/p${i + 1}`, notes: '', icon: '', pr_enabled: null }));

const server = setupServer(http.get('*/api/projects', () => HttpResponse.json(PROJECTS)));
beforeAll(() => server.listen({ onUnhandledRequest })); afterAll(() => server.close());

const renderPills = (value: number | 'all' = 'all', variant: 'pills' | 'dropdown' = 'pills') => {
  const { wrapper: Wrapper } = createWrapper();
  function StatefulPills() {
    const [selected, setSelected] = useState<number | 'all'>(value);
    return <ProjectFilterPills value={selected} onChange={setSelected} variant={variant} />;
  }
  return render(<Wrapper><StatefulPills /></Wrapper>);
};

describe('ProjectFilterPills folding (long workspaces must not flood the header row)', () => {
  it('shows 5 project pills + "+N more", and expands the rest on click', async () => {
    renderPills();
    await waitFor(() => expect(screen.getByText('proj-1')).toBeTruthy());
    const group = screen.getByRole('group', { name: /project/i });
    expect(group.className).toContain('flex-wrap');
    expect(group.className).toContain('max-w-full');
    expect(group.className).not.toContain('flex-nowrap');
    expect(group.className).not.toContain('shrink-0');
    expect(screen.getByText('proj-5')).toBeTruthy();
    expect(screen.queryByText('proj-6')).toBeNull();               // folded
    const more = screen.getByRole('button', { name: '+3 more' }); // 8 - 5 = 3
    fireEvent.click(more);
    expect(screen.getByText('proj-8')).toBeTruthy();               // expanded → wraps below
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('proj-8')).toBeNull();
  });

  it('keeps a selected project from the folded tail visible without reshuffling', async () => {
    renderPills(7);
    await waitFor(() => expect(screen.getByText('proj-1')).toBeTruthy());
    const selected = screen.getByText('proj-7').closest('button')!;
    expect(selected.getAttribute('aria-pressed')).toBe('true');    // visible as the extra pill
    expect(screen.queryByText('proj-6')).toBeNull();               // the rest of the tail stays folded
    expect(screen.getByRole('button', { name: '+2 more' })).toBeTruthy(); // 8 - 5 - 1 shown extra
  });

  it('short lists render everything with no toggle', async () => {
    server.use(http.get('*/api/projects', () => HttpResponse.json(PROJECTS.slice(0, 3))));
    renderPills();
    await waitFor(() => expect(screen.getByText('proj-3')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('renders a compact project dropdown with All projects selected by default', async () => {
    renderPills('all', 'dropdown');
    const trigger = await screen.findByRole('button', { name: 'Project filter' });
    expect(trigger).toHaveTextContent('All projects');
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'All projects' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'proj-3' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'proj-3' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveTextContent('proj-3');
  });
});
