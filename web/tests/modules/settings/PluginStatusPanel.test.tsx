import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '../../../lib/i18n';
import { en } from '../../../lib/i18n/dictionaries/en';
import type { ReadinessCheck } from '../../../lib/types';

const useSystemReadiness = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/queries', () => ({ useSystemReadiness }));

import { PluginStatusPanel } from '../../../modules/settings/PluginStatusPanel';

const show = (checks: ReadinessCheck[] | undefined, name = 'sites') => {
  useSystemReadiness.mockReturnValue({ data: checks ? { checks } : undefined });
  return render(<LanguageProvider><PluginStatusPanel name={name} /></LanguageProvider>);
};

beforeEach(() => { useSystemReadiness.mockReset(); });

describe('PluginStatusPanel', () => {
  // Every plugin's settings screen mounts this. A plugin that reports nothing must render nothing at
  // all, or the panel becomes an empty card on twenty screens that answers no question.
  it('renders nothing for a plugin that contributes no readiness row', () => {
    const { container } = show([
      { id: 'chat', label: 'Chat', ok: true, detail: 'kimi' },
      { id: 'cron-clock', label: 'Cron', ok: true, detail: 'running', plugin: 'cronjob' },
    ]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the readiness query has not answered', () => {
    const { container } = show(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('reports a healthy plugin with its own row only', () => {
    show([
      { id: 'chat', label: 'Chat', ok: true, detail: 'kimi' },
      { id: 'sites-gateway', label: 'Published sites gateway', ok: true, detail: 'sites.example.test', plugin: 'sites' },
    ]);
    expect(screen.getByText(en.pluginDetail.statusOk)).toBeTruthy();
    expect(screen.getByText('Published sites gateway')).toBeTruthy();
    expect(screen.getByText('sites.example.test')).toBeTruthy();
    // The daemon's own row belongs to the onboarding report, not to this plugin's screen.
    expect(screen.queryByText('Chat')).toBeNull();
  });

  // The whole point of the panel: a failing subsystem hands over the exact values to transcribe. The
  // detail carries the real cause, which for this gateway is the only place it ever appears.
  it('shows the cause, the instruction and every value to copy when something is wrong', () => {
    show([{
      id: 'sites-gateway',
      label: 'Published sites gateway',
      ok: false,
      detail: '*.sites.example.test does not resolve',
      hint: 'Add this DNS record at the registrar for your domain.',
      plugin: 'sites',
      fix: [
        { label: 'Type', value: 'CNAME' },
        { label: 'Name', value: '*.sites.example.test' },
        { label: 'Value', value: 'app.example.test.' },
      ],
    }]);
    expect(screen.getByText(en.pluginDetail.statusProblem.replace('{n}', '1'))).toBeTruthy();
    expect(screen.getByText('*.sites.example.test does not resolve')).toBeTruthy();
    expect(screen.getByText('Add this DNS record at the registrar for your domain.')).toBeTruthy();
    for (const value of ['CNAME', '*.sites.example.test', 'app.example.test.']) {
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
    // One copy control per value: these are retyped by hand into a registrar's panel.
    expect(screen.getAllByRole('button', { name: en.pluginDetail.statusCopy })).toHaveLength(3);
  });

  // A healthy row has nothing to fix, so the instruction and the copy fields must not linger from the
  // shape of the data — an operator reading "add this DNS record" under a working gateway would go and
  // change a record that is already correct.
  it('hides the instruction and the values once the check passes', () => {
    show([{
      id: 'sites-gateway', label: 'Published sites gateway', ok: true, detail: 'sites.example.test', plugin: 'sites',
      hint: 'Add this DNS record at the registrar for your domain.',
      fix: [{ label: 'Type', value: 'CNAME' }],
    }]);
    expect(screen.queryByText('Add this DNS record at the registrar for your domain.')).toBeNull();
    expect(screen.queryByRole('button', { name: en.pluginDetail.statusCopy })).toBeNull();
  });
});
