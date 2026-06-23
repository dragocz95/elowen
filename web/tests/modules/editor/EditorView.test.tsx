import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from '../../test-utils';

// Monaco is browser-only and heavy — swap the real editor for a stub that echoes its project id.
vi.mock('../../../modules/projects/editor/ProjectEditor', () => ({
  ProjectEditor: ({ projectId }: { projectId: number }) => <div data-testid="editor">project:{projectId}</div>,
}));

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
  it('opens the editor on the first project by default', () => {
    projectList = PROJECTS;
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.getByTestId('editor').textContent).toBe('project:7');
  });

  it('shows an empty state when there are no projects', () => {
    projectList = [];
    const { wrapper } = createWrapper();
    render(<EditorView />, { wrapper });
    expect(screen.queryByTestId('editor')).toBeNull();
  });
});
