import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MAX_ROW_ACTIONS, SettingsDocument, SettingsGroup, SettingsRow } from '../../../components/ui/SettingsSurface';
import { SpatialRow } from '../../../components/ui/SpatialPrimitives';
import { createWrapper } from '../../test-utils';

describe('SettingsSurface', () => {
  it('renders one shared document grammar for grouped settings and compact rows', () => {
    const { wrapper } = createWrapper();
    const { container } = render(
      <SettingsDocument>
        <SettingsGroup title="Runtime" description="Runtime controls" density="compact">
          <SettingsRow label="Daemon" description="Daemon status">
            <span>Running</span>
          </SettingsRow>
        </SettingsGroup>
      </SettingsDocument>, { wrapper },
    );

    expect(container.querySelectorAll('[data-settings-document]')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Runtime' })).toBeInTheDocument();
    expect(screen.getByText('Daemon')).toBeInTheDocument();
    expect(container.querySelector('[data-settings-group]')).toHaveAttribute('data-density', 'compact');
  });

  it('keeps danger as a tone of the same geometry', () => {
    const { container } = render(
      <SettingsDocument>
        <SettingsGroup title="Danger zone" tone="danger"><span>Delete</span></SettingsGroup>
      </SettingsDocument>,
    );

    expect(container.querySelector('[data-settings-group]')).toHaveAttribute('data-tone', 'danger');
    expect(container.querySelector('.settings-group')).toBeInTheDocument();
  });
});

/** The canonical record: a label and ONE control, optionally a short status and at most two actions.
 *  These pin the source/DOM side of it. The layout half — one grid row on a wide card, a two-line band
 *  in a narrow container — is pinned in tests/app/settingsThemeGlobal.test.ts, against the stylesheets. */
describe('SettingsRow anatomy', () => {
  const trailing = (container: HTMLElement) => container.querySelector('.settings-row__trailing')!;

  it('puts status, control and actions in one trailing cell, in that order', () => {
    const { container } = render(
      <SettingsRow label="Executor" status={<span>Relay</span>} control={<button type="button">Pick</button>} actions={<button type="button">Reset</button>} />,
    );

    expect([...trailing(container).children].map((child) => child.className)).toEqual([
      'settings-row__status', 'settings-row__control', 'settings-row__actions',
    ]);
  });

  /** `children` is the published plugin ABI — every bundle handed `SettingsRow` through
   *  `window.ElowenUiRuntime.components` passes its control that way — so the canonical `control` prop
   *  has to be an ALIAS rather than a replacement. Identical DOM is the whole claim. */
  it('renders `children` and `control` to the same markup', () => {
    const viaChildren = render(<SettingsRow label="Daemon"><span>Running</span></SettingsRow>);
    const viaControl = render(<SettingsRow label="Daemon" control={<span>Running</span>} />);

    expect(viaChildren.container.innerHTML).toBe(viaControl.container.innerHTML);
    expect(viaChildren.container.querySelector('.settings-row__control')).toHaveTextContent('Running');
  });

  it('draws no trailing cell for a record that carries nothing', () => {
    const { container } = render(<SettingsRow label="Just a label" />);

    expect(container.querySelector('.settings-row__trailing')).toBeNull();
    expect(container.querySelector('.settings-row')).toHaveAttribute('data-trailing', 'inline');
  });

  it('keeps `trailingLayout="stack"` as the declared opt-out for a multi-value record', () => {
    const { container } = render(
      <SettingsRow label="Claude account" trailingLayout="stack" status={<span>Connected</span>} />,
    );

    expect(container.querySelector('.settings-row')).toHaveAttribute('data-trailing', 'stack');
  });

  describe('the two-action ceiling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    afterEach(() => warn.mockClear());

    it('accepts the ceiling silently', () => {
      render(<SettingsRow label="Provider" actions={<><button type="button">Edit</button><button type="button">Remove</button></>} />);

      expect(MAX_ROW_ACTIONS).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    });

    /** Counted THROUGH the fragment. `Children.count` reports this as one node, which is the shape
     *  almost every call site hands in — so a check that trusted it would report every overloaded row
     *  as compliant and the ceiling would mean nothing. */
    it('warns when a call site exceeds it, fragment or not', () => {
      render(<SettingsRow label="Provider" actions={<><button type="button">Edit</button><button type="button">Test</button><button type="button">Remove</button></>} />);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"Provider"'));
    });
  });
});

/** The account page's spelling of the same record. It delegates, so the only thing worth pinning is
 *  that the delegation is complete: its own `title`/`children` vocabulary AND the canonical slots. */
describe('SpatialRow', () => {
  it('forwards the canonical slots and keeps its own title/children vocabulary', () => {
    const { container } = render(
      <SpatialRow title="Default worker" status={<span>Relay</span>} actions={<button type="button">Reset</button>}>
        <button type="button">Pick</button>
      </SpatialRow>,
    );

    expect(screen.getByText('Default worker')).toBeInTheDocument();
    expect(container.querySelector('.settings-row__control')).toHaveTextContent('Pick');
    expect(container.querySelector('.settings-row__status')).toHaveTextContent('Relay');
    expect(container.querySelector('.settings-row__actions')).toHaveTextContent('Reset');
  });

  it('prefers an explicit control over the children alias', () => {
    const { container } = render(
      <SpatialRow title="Default worker" control={<span>Canonical</span>}><span>Alias</span></SpatialRow>,
    );

    expect(container.querySelector('.settings-row__control')).toHaveTextContent('Canonical');
  });
});
