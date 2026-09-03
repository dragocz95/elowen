import { useState, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UserPluginConfigDetail } from '../../../lib/types';
import { UserPluginConfigSection } from '../../../modules/account/UserPluginConfigSection';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  retry: vi.fn(async () => {}),
}));

vi.mock('../../../lib/i18n', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: {
      account: { personalPluginConfig: 'Personal plugin configuration' },
      pluginDetail: { riskHigh: 'High', riskMedium: 'Medium', riskLow: 'Low' },
    },
  }),
}));
vi.mock('../../../lib/mutations', () => ({
  useSaveUserPluginConfig: () => ({ mutateAsync: mocks.mutateAsync }),
}));
vi.mock('../../../lib/usePluginConfigDraft', () => ({
  usePluginConfigDraft: () => ({
    values: { mergeMethod: 'squash' },
    setValue: vi.fn(),
    commitValue: vi.fn(),
    status: 'saved',
    errorKind: null,
    conflict: null,
    retry: mocks.retry,
    flush: vi.fn(),
    resolveConflict: vi.fn(),
    ready: true,
  }),
}));
vi.mock('../../../components/ui/AutoSaveStatus', () => ({ AutoSaveStatus: () => null }));
vi.mock('../../../components/ui/SettingsSurface', () => ({
  SettingsGroup: ({ title, description, children }: { title?: ReactNode; description?: ReactNode; children: ReactNode }) => (
    <div>
      <h2>{title}</h2>
      <p data-testid="group-description">{description}</p>
      {children}
    </div>
  ),
}));
vi.mock('../../../modules/settings/PluginConfigEditor', () => ({ PluginConfigEditor: () => <div>Editor</div> }));

const detail: UserPluginConfigDetail = {
  name: 'github',
  label: 'GitHub',
  description: 'GitHub configuration',
  config: { mergeMethod: 'squash' },
  revision: 0,
  secretsSet: [],
  userConfigSchema: [{
    key: 'mergeMethod',
    label: 'Default merge method',
    type: 'enum',
    options: [{ value: 'squash', label: 'Squash' }],
  }],
};

describe('UserPluginConfigSection heading', () => {
  // The panel header is a title and a caption, so it takes the plugin's short label and its sentence —
  // the same pair the rail and the hero read. It used to title itself with the description and caption
  // itself with the host's generic line, which said the plugin's name nowhere.
  it('titles the panel with the plugin\'s short label and captions it with the manifest sentence', () => {
    render(
      <UserPluginConfigSection sectionId="plugin-user-config:github" detail={detail} onSaveStateAction={() => {}} />,
    );
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument();
    expect(screen.getByTestId('group-description')).toHaveTextContent('GitHub configuration');
  });

  it('falls back to the host caption for a plugin that ships no description', () => {
    render(
      <UserPluginConfigSection
        sectionId="plugin-user-config:github"
        detail={{ ...detail, description: undefined }}
        onSaveStateAction={() => {}}
      />,
    );
    expect(screen.getByTestId('group-description')).toHaveTextContent('Personal plugin configuration');
  });
});

describe('UserPluginConfigSection save feedback', () => {
  it('reports a stable status once even when its parent recreates the callback after every report', async () => {
    function Harness() {
      const [reports, setReports] = useState(0);
      return (
        <>
          <span data-testid="reports">{reports}</span>
          <UserPluginConfigSection
            sectionId="plugin-user-config:github"
            detail={detail}
            onSaveStateAction={() => setReports((count) => count + 1)}
          />
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('reports')).toHaveTextContent('1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId('reports')).toHaveTextContent('1');
  });
});
