import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrainCircuit } from 'lucide-react';
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

/** The canonical record: a label and ONE control, optionally a short status and at most three actions.
 *  These pin the source/DOM side of it. The layout half — one grid row on a wide card, a two-line band
 *  in a narrow container — is pinned in tests/app/settingsThemeGlobal.test.ts, against the stylesheets. */
describe('SettingsRow anatomy', () => {
  const trailing = (container: HTMLElement) => container.querySelector('.settings-row__trailing')!;

  it('marks supplied icon nodes as brands and Lucide icons as glyphs', () => {
    const { container } = render(
      <>
        <SettingsRow label="Provider" iconNode={<span data-testid="provider-mark" />} />
        <SettingsRow label="Runtime" icon={BrainCircuit} />
      </>,
    );

    expect(screen.getByTestId('provider-mark').closest('.settings-row__icon')).toHaveAttribute('data-icon-kind', 'brand');
    expect(container.querySelector('.settings-row:nth-child(2) .settings-row__icon')).toHaveAttribute('data-icon-kind', 'glyph');
  });

  /** THE STATUS READS WITH THE LABEL. An inline record's status states something about the SETTING, so it
   *  is the label line's LAST child — directly after the name and its help mark — and not a slot in the
   *  trailing band. Held in a band track of its own it floated between the name and the control, and the
   *  single record in a card that carried a pill made the whole card read as scattered. */
  it('reads an inline status on the label line, straight after the name and its help mark', () => {
    const { wrapper } = createWrapper();
    const { container } = render(
      <SettingsRow label="Executor" description="What runs a turn" status={<span>Relay</span>} control={<button type="button">Pick</button>} actions={<button type="button">Reset</button>} />,
      { wrapper },
    );

    const title = [...container.querySelector('.settings-row__title')!.children];
    expect(title).toHaveLength(3);
    expect(title[0]).toHaveTextContent('Executor');
    expect(title[1]).toContainElement(screen.getByRole('button', { name: /help/i }));
    expect(title[2]).toHaveClass('settings-row__status');
    expect(title[2]).toHaveTextContent('Relay');
    expect(trailing(container).querySelector('.settings-row__status')).toBeNull();
  });

  /** THE CONTROL KEEPS ONE COLUMN. jsdom measures no pixels, so the claim is pinned where it is decided:
   *  the trailing cell opens with the control whether or not the record carries actions, and the
   *  stylesheet places that cell in track 3 for every record (tests/app/settingsThemeGlobal.test.ts). A
   *  record with a trailing action can therefore no longer pull its own switch out of the column its
   *  neighbours' switches sit in — which is exactly what the Recap card's digest row did. */
  it('opens the trailing cell with the control, with and without trailing actions', () => {
    const withActions = render(
      <SettingsRow label="Recap" status={<span>Ready</span>} control={<button type="button">On</button>} actions={<button type="button">Regenerate</button>} />,
    );
    const withoutActions = render(
      <SettingsRow label="Greeting" control={<button type="button">On</button>} />,
    );

    expect([...trailing(withActions.container).children].map((child) => child.className))
      .toEqual(['settings-row__control', 'settings-row__actions']);
    expect([...trailing(withoutActions.container).children].map((child) => child.className))
      .toEqual(['settings-row__control']);
  });

  /** A stacked record is the one exception, and it keeps the band's status track: its status is a BLOCK
   *  (a provider's endpoint over a model count over a badge row) that cannot sit on a label's baseline. */
  it('keeps a stacked record\'s block status in the trailing band', () => {
    const { container } = render(
      <SettingsRow label="Relay" trailingLayout="stack" status={<span>https://example.test</span>} actions={<button type="button">Edit</button>} />,
    );

    expect(container.querySelector('.settings-row__title > .settings-row__status')).toBeNull();
    expect([...trailing(container).children].map((child) => child.className))
      .toEqual(['settings-row__status', 'settings-row__actions']);
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

  describe('the three-action ceiling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    afterEach(() => warn.mockClear());

    it('accepts the ceiling silently', () => {
      render(<SettingsRow label="Provider" actions={<><button type="button">Edit</button><button type="button">Settings</button><button type="button">Remove</button></>} />);

      expect(MAX_ROW_ACTIONS).toBe(3);
      expect(warn).not.toHaveBeenCalled();
    });

    /** Counted THROUGH the fragment. `Children.count` reports this as one node, which is the shape
     *  almost every call site hands in — so a check that trusted it would report every overloaded row
     *  as compliant and the ceiling would mean nothing. */
    it('warns when a call site exceeds it, fragment or not', () => {
      render(<SettingsRow label="Provider" actions={<><button type="button">Edit</button><button type="button">Test</button><button type="button">Settings</button><button type="button">Remove</button></>} />);

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
