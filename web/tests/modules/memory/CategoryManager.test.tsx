import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../components/ui/Toast';
import { createWrapper } from '../../test-utils';
import type { MemoryCategory } from '../../../lib/types';

const createCategory = vi.fn();
const updateCategory = vi.fn();
const projects = [{ id: 9, slug: 'kolin', path: '/work/kolin', notes: '', icon: '' }];

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useProjects: () => ({ data: projects, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../../lib/mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCreateMemoryCategory: () => ({ mutate: createCategory, isPending: false }),
  useUpdateMemoryCategory: () => ({ mutate: updateCategory, isPending: false }),
  useDeleteMemoryCategory: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { CategoryModal } from '../../../modules/memory/CategoryManager';

const renderModal = (category?: MemoryCategory) => render(
  <ToastProvider><CategoryModal category={category} onClose={vi.fn()} /></ToastProvider>,
  { wrapper: createWrapper().wrapper },
);

describe('CategoryModal project scope picker', () => {
  it('keeps a new category global until a project is selected', () => {
    renderModal();
    expect(screen.getByText('Global (all conversations)')).toBeInTheDocument();
  });

  it('sends the selected project id through the category mutation', async () => {
    renderModal();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name Required' }), { target: { value: 'Planning' } });
    fireEvent.click(screen.getByRole('button', { name: 'Project scope' }));
    fireEvent.click(screen.getByRole('button', { name: 'kolin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createCategory).toHaveBeenCalledWith(expect.objectContaining({ name: 'Planning', projectId: 9 }), expect.anything()));
  });
});

describe('CategoryModal name validation', () => {
  it('states a missing name on the field itself and clears it once something is typed', async () => {
    createCategory.mockClear();
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent('The category name is required');
    expect(createCategory).not.toHaveBeenCalled();
    const input = screen.getByRole('textbox', { name: 'Name Required' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', message.id);

    fireEvent.change(input, { target: { value: 'Planning' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
