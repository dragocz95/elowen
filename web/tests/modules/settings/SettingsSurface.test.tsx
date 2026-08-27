import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsDocument, SettingsGroup, SettingsRow } from '../../../components/ui/SettingsSurface';
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
