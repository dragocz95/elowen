import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const route = vi.hoisted(() => ({ value: '/chat' }));
const viewport = vi.hoisted(() => ({ mobile: true as boolean | undefined }));

vi.mock('next/navigation', () => ({ usePathname: () => route.value }));
vi.mock('../../../lib/useMobile', () => ({ useMobileViewport: () => viewport.mobile }));

import { TelemetryRailProvider, useTelemetryRail } from '../../../modules/advisor/telemetryRailState';

function Probe() {
  const rail = useTelemetryRail();
  if (!rail) return null;
  return (
    <>
      <button type="button" onClick={() => rail.setMobileOpen(true)}>open mobile</button>
      <button type="button" onClick={() => rail.openWorkflow('workflow-1')}>open workflow</button>
      <span data-testid="mobile-state">{String(rail.mobileOpen)}</span>
      <span data-testid="workflow-state">{rail.workflowId ?? 'none'}</span>
    </>
  );
}

function renderProbe() {
  return render(<TelemetryRailProvider><Probe /></TelemetryRailProvider>);
}

describe('telemetry rail transient state', () => {
  it('closes the phone drawer and workflow modal when chat is left', async () => {
    route.value = '/chat';
    viewport.mobile = true;
    const view = renderProbe();
    fireEvent.click(screen.getByRole('button', { name: 'open mobile' }));
    fireEvent.click(screen.getByRole('button', { name: 'open workflow' }));
    expect(screen.getByTestId('workflow-state')).toHaveTextContent('workflow-1');

    route.value = '/dash';
    view.rerender(<TelemetryRailProvider><Probe /></TelemetryRailProvider>);
    await waitFor(() => expect(screen.getByTestId('mobile-state')).toHaveTextContent('false'));
    expect(screen.getByTestId('workflow-state')).toHaveTextContent('none');
  });

  it('closes the phone drawer when the viewport widens', async () => {
    route.value = '/chat';
    viewport.mobile = true;
    const view = renderProbe();
    fireEvent.click(screen.getByRole('button', { name: 'open mobile' }));
    expect(screen.getByTestId('mobile-state')).toHaveTextContent('true');

    viewport.mobile = false;
    await act(async () => {
      view.rerender(<TelemetryRailProvider><Probe /></TelemetryRailProvider>);
    });
    await waitFor(() => expect(screen.getByTestId('mobile-state')).toHaveTextContent('false'));
  });
});
