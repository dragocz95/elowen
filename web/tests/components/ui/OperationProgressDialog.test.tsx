import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import { OperationProgressDialog } from '../../../components/ui/OperationProgressDialog';
import type { EnvironmentOperation } from '../../../../src/shared/wireContract';

const operation = (over: Partial<EnvironmentOperation> = {}): EnvironmentOperation => ({
  id: 'env_op_1', requestId: 'r', projectId: 7, accountUserId: 1, generation: 1,
  action: { kind: 'start' }, status: 'running', error: null,
  steps: ['image', 'storage', 'container', 'boot', 'initialize'], stepIndex: 0, stepTotal: 5,
  stepLabel: 'image', percent: 12.5, ...over,
});

function mount(props: Partial<Parameters<typeof OperationProgressDialog>[0]> = {}) {
  const { wrapper: Wrapper } = createWrapper();
  const onClose = vi.fn();
  const result = render(
    <Wrapper>
      <OperationProgressDialog open title="Starting the environment" operation={operation()} onClose={onClose} {...props} />
    </Wrapper>,
  );
  return { ...result, onClose };
}

describe('OperationProgressDialog', () => {
  it('reports a known percentage on the meter itself', () => {
    mount();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '12.5');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    expect(screen.getByText('Preparing the base image')).toBeInTheDocument();
  });

  // `null` percent is the honest answer for work whose inside nobody can measure. It must NOT become a
  // number: a screen reader announcing "0 percent" for ten minutes is worse than announcing nothing.
  it('drops the value entirely while the step is indeterminate', () => {
    mount({ operation: operation({ percent: null }) });
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });

  it('marks itself busy while the operation runs and not once it has settled', () => {
    const { rerender } = mount();
    expect(screen.getByTestId('operation-progress-dialog')).toHaveAttribute('aria-busy', 'true');
    const { wrapper: Wrapper } = createWrapper();
    rerender(
      <Wrapper>
        <OperationProgressDialog open title="Starting the environment" operation={operation({ status: 'failed', error: 'boom' })} onClose={vi.fn()} />
      </Wrapper>,
    );
    expect(screen.getByTestId('operation-progress-dialog')).not.toHaveAttribute('aria-busy');
  });

  // Escape is never a cancel. While the work runs it hides a window over a durable operation that keeps
  // going, and the caller is told which of the two happened so it can decide whether to keep following.
  it('reports whether the operation was still running when Escape dismissed it', () => {
    const running = mount();
    fireEvent.keyDown(screen.getByTestId('operation-progress-dialog'), { key: 'Escape' });
    expect(running.onClose).toHaveBeenCalledWith({ running: true });

    running.unmount();
    const settled = mount({ operation: operation({ status: 'failed', error: 'boom' }) });
    fireEvent.keyDown(screen.getByTestId('operation-progress-dialog'), { key: 'Escape' });
    expect(settled.onClose).toHaveBeenCalledWith({ running: false });
  });

  it('shows the failure, its retry and — only when the failure names it — the recreate repair', () => {
    const onRetry = vi.fn();
    const onRecreate = vi.fn();
    const { unmount } = mount({ operation: operation({ status: 'failed', error: 'Container start could not be verified' }), onRetry, onRecreate });
    expect(screen.getByRole('alert')).toHaveTextContent('Container start could not be verified');
    expect(screen.queryByRole('button', { name: 'Recreate environment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();

    unmount();
    mount({ operation: operation({ status: 'failed', error: 'predates the named project mount' }), onRetry, onRecreate, recreatable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Recreate environment' }));
    expect(onRecreate).toHaveBeenCalledOnce();
  });

  it('closes itself after a success and tells the caller once', async () => {
    const onSettled = vi.fn();
    const { onClose } = mount({ operation: operation({ status: 'succeeded', percent: 100, stepIndex: 4, stepLabel: 'initialize' }), onSettled, successDelayMs: 20 });
    expect(screen.getByText('Done')).toBeInTheDocument();
    await waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledWith({ running: false });
  });

  // Every call site hands this dialog inline arrows, so a parent that re-renders while the success is on
  // screen gives it fresh callback identities. The self-close must survive that: it is what tells the
  // caller the operation is over.
  it('closes itself after a success even when the parent re-renders during the window', async () => {
    const onSettled = vi.fn();
    const onClose = vi.fn();
    const { wrapper: Wrapper } = createWrapper();
    const settled = operation({ status: 'succeeded', percent: 100, stepIndex: 4, stepLabel: 'initialize' });
    const view = (tick: number) => (
      <Wrapper>
        <OperationProgressDialog
          open
          title={`Starting the environment ${tick}`}
          operation={settled}
          onSettled={() => onSettled()}
          onClose={(info) => onClose(info)}
          successDelayMs={20}
        />
      </Wrapper>
    );
    const { rerender } = render(view(1));
    rerender(view(2));
    rerender(view(3));
    await waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledWith({ running: false });
  });

  // A seed read that failed leaves no operation to render. Without it the dialog shows "Preparing" for
  // as long as the window is open, which is the one thing the transport error already knows is wrong.
  it('reports a failed read instead of a bar that never moves', () => {
    mount({ operation: null, loadError: 'operation read failed (503)' });
    expect(screen.getByRole('alert')).toHaveTextContent('operation read failed (503)');
  });

  it('keeps the log tail behind an expandable control rather than in the way', () => {
    mount({ logTail: ['STEP 1/4: FROM debian', 'STEP 2/4: RUN apt-get update'] });
    const toggle = screen.getByRole('button', { name: 'Show log' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/apt-get update/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide log' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/apt-get update/)).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><OperationProgressDialog open={false} title="x" operation={operation()} onClose={vi.fn()} /></Wrapper>);
    expect(screen.queryByTestId('operation-progress-dialog')).toBeNull();
  });
});
