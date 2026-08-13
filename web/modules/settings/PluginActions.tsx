'use client';
import { Toggle } from '../../components/ui/Toggle';
import { HelpTip } from '../../components/ui/HelpTip';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePluginConsent } from './usePluginConsent';
import type { PluginDetail } from '../../lib/types';

/** The plugin's install-state actions: the live enable/disable switch with its help tip. Enabling one
 *  that claims power over stored state asks first — the dialog comes from the shared consent hook. */
export function PluginActions({ name, detail }: { name: string; detail: PluginDetail }) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const consent = usePluginConsent({
    // A deferred swap still saved the change, so the switch stays flipped — the toast explains why the
    // plugin's pages and tools appear a moment later instead of leaving the delay unexplained.
    onSuccess: (res) => { if (res.pending) toast(t.plugins.pendingToast, 'ok'); },
    onError: () => toast(t.plugins.toggleError, 'error'),
  });
  return (
    <div className="flex items-center gap-2">
      <Toggle
        checked={detail.enabled}
        onChange={(v) => consent.setEnabled(name, v)}
        label={detail.name}
        disabled={consent.isBusy(name)}
      />
      <HelpTip align="left">{t.help.pluginEnable}</HelpTip>
      {consent.dialog}
    </div>
  );
}
