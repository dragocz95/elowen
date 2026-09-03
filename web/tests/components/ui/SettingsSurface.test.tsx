import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsGroup, SettingsRow } from '../../../components/ui/SettingsSurface';
import { createWrapper } from '../../test-utils';

const trigger = (container: HTMLElement) => container.querySelector('.settings-group__trigger') as HTMLButtonElement;

describe('SettingsGroup — collapsible', () => {
  /** Collapsed by default is the whole point: a long settings deck reads top-down through one-line
   *  summaries instead of eight open groups of rows. The rows STAY MOUNTED underneath — deep links and
   *  in-page search must reach what is folded away. */
  it('starts closed with the rows still in the DOM', () => {
    const { container } = render(
      <SettingsGroup title="Model roles" description="Which model does what." collapsible>
        <SettingsRow label="Default chat model" status={<span>claude-opus</span>} />
        <SettingsRow label="Utility model" />
      </SettingsGroup>,
    );

    expect(trigger(container)).toHaveAttribute('aria-expanded', 'false');
    expect(trigger(container)).toHaveAttribute('type', 'button');
    expect(trigger(container)).toHaveAttribute('aria-controls');
    const body = container.querySelector('.settings-group__body')!;
    expect(body).toHaveAttribute('hidden');
    expect(body).toHaveAttribute('data-state', 'closed');
    expect(container.querySelectorAll('.settings-row')).toHaveLength(2);
  });

  it('opens on click and reports state through aria', () => {
    const { container } = render(
      <SettingsGroup title="Model roles" collapsible><SettingsRow label="Row" /></SettingsGroup>,
    );

    fireEvent.click(trigger(container));
    expect(trigger(container)).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.settings-group__body')).not.toHaveAttribute('hidden');
    expect(container.querySelector('.settings-group__body')).toHaveAttribute('data-state', 'open');
  });

  /** The trigger is a NATIVE button, so Enter and Space fold the group through the browser's own click
   *  activation — no key handling of our own to drift. jsdom does not synthesize that click, which is
   *  why this pins the element rather than the keys. */
  it('is a native button, so the keyboard reaches it through click activation', () => {
    const { container } = render(
      <SettingsGroup title="Model roles" collapsible><SettingsRow label="Row" /></SettingsGroup>,
    );
    const button = trigger(container);
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  /** Controlled mode: the component reports, the caller decides. A click must not open the group on its
   *  own — that is what makes "open this group from the sibling task's deep link" possible. */
  it('stays closed in controlled mode and hands the decision to onOpenChange', () => {
    const onOpenChange = vi.fn();
    const { container } = render(
      <SettingsGroup title="Model roles" collapsible open={false} onOpenChange={onOpenChange}>
        <SettingsRow label="Row" />
      </SettingsGroup>,
    );

    fireEvent.click(trigger(container));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(trigger(container)).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.settings-group__body')).toHaveAttribute('hidden');
  });

  it('honours defaultOpen and a controlled open of true', () => {
    const { container: uncontrolled } = render(
      <SettingsGroup title="Open" collapsible defaultOpen><SettingsRow label="Row" /></SettingsGroup>,
    );
    const { container: controlled } = render(
      <SettingsGroup title="Open" collapsible open><SettingsRow label="Row" /></SettingsGroup>,
    );

    expect(trigger(uncontrolled)).toHaveAttribute('aria-expanded', 'true');
    expect(uncontrolled.querySelector('.settings-group__body')).not.toHaveAttribute('hidden');
    expect(trigger(controlled)).toHaveAttribute('aria-expanded', 'true');
  });

  /** The actions are a SIBLING of the trigger button, not a child — nesting is what keeps an action
   *  click from bubbling into the fold, and no stopPropagation hacks anywhere. */
  it('keeps header actions clickable without toggling the group', () => {
    const action = vi.fn();
    const { container } = render(
      <SettingsGroup
        title="Model roles"
        collapsible
        actions={<button type="button" onClick={action}>Add provider</button>}
      >
        <SettingsRow label="Row" />
      </SettingsGroup>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    expect(action).toHaveBeenCalledOnce();
    expect(trigger(container)).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders no trigger furniture at all without `collapsible`', () => {
    const { wrapper } = createWrapper();
    const { container } = render(
      <SettingsGroup title="Runtime" description="Runtime controls" actions={<button type="button">Reset</button>}>
        <SettingsRow label="Daemon" />
      </SettingsGroup>, { wrapper },
    );

    // The only button in the header is the caller's action — no fold trigger anywhere.
    expect([...container.querySelectorAll('.settings-group__header button')]).toHaveLength(1);
    expect(container.querySelector('.settings-group__chevron')).toBeNull();
    expect(container.querySelector('.settings-group__trigger')).toBeNull();
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
    expect(container.querySelector('[data-settings-group]')).not.toHaveAttribute('aria-expanded');
    expect(container.querySelector('.settings-group__body')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });
});