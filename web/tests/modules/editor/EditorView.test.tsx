import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createWrapper } from '../../test-utils';

// Monaco is browser-only and heavy — swap the real editor for a stub that echoes its project id and
// surfaces whether it received an onClose (and lets us invoke it) so we can assert the mobile back-out.
vi.mock('../../../modules/projects/editor/ProjectEditor', () => ({
  ProjectEditor: ({ projectId, onClose }: { projectId: number; onClose?: () => void }) => (
    <div data-testid="editor" data-hasclose={onClose ? '1' : '0'}>
      project:{projectId}
      {onClose ? <button type="button" onClick={onClose}>back</button> : null}
    </div>
  ),
}));

const pushSpy = vi.fn();
const backSpy = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushSpy, back: backSpy }) }));

let mobileFlag = false;
vi.mock('../../../lib/useMobile', () => ({ useMobile: () => mobileFlag }));

const PROJECTS = [
  { id: 7, slug: 'orca', path: '/p/orca', notes: '', icon: '' },
  { id: 9, slug: 'other', path: '/p/other', notes: '', icon: '' },
];
let projectList: typeof PROJECTS = PROJECTS;
vi.mock('../../../lib/queries', async (orig) => ({
  ...(await orig() as object),
  useProjects: () => ({ data: projectList }),
}));

import { EditorView } from '../../../modules/editor/EditorView';

describe('EditorView', () => {
  beforeEach(() => { projectList = PROJECTS; mobileFlag = false; pushSpy.mockClear(); backSpy.mockClear(); });

  it('opens the editor on the first project by default', () => {
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.getByTestId('editor').textContent).toContain('project:7');
  });

  it('shows an empty state when there are no projects', () => {
    projectList = [];
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('passes no onClose on desktop (the sidebar nav is always reachable)', () => {
    mobileFlag = false;
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.getByTestId('editor').getAttribute('data-hasclose')).toBe('0');
  });

  it('offers a project picker but never an "All projects" option', () => {
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    // Both projects are selectable…
    expect(screen.getByText('orca')).toBeTruthy();
    expect(screen.getByText('other')).toBeTruthy();
    // …but the editor edits exactly one, so the "All projects" pill must not be there.
    expect(screen.queryByText('All projects')).toBeNull();
  });

  it('on mobile gives the editor a way back to the app', () => {
    mobileFlag = true;
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.getByTestId('editor').getAttribute('data-hasclose')).toBe('1');
    fireEvent.click(screen.getByText('back'));
    // jsdom starts with a single history entry, so the fallback lands on the dashboard.
    expect(pushSpy).toHaveBeenCalledWith('/dash');
  });
});
