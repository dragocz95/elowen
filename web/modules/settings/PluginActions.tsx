'use client';
import { Toggle } from '../../components/ui/Toggle';
import { HelpTip } from '../../components/ui/HelpTip';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useTogglePlugin } from '../../lib/mutations';
import type { PluginDetail } from '../../lib/types';

/** The plugin's install-state actions: the live enable/disable switch with its help tip. */
export function PluginActions({ name, detail }: { name: string; detail: PluginDetail }) {
  const toggle = useTogglePlugin();
  const { toast } = useToast();
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <Toggle
        checked={detail.enabled}
        // A deferred swap still saved the change, so the switch stays flipped — the toast explains why the
        // plugin's pages and tools appear a moment later instead of leaving the delay unexplained.
        onChange={(v) => toggle.mutate({ name, enabled: v }, {
          onSuccess: (res) => { if (res.pending) toast(t.plugins.pendingToast, 'ok'); },
        })}
        label={detail.name}
        disabled={toggle.isPending}
      />
      <HelpTip align="left">{t.help.pluginEnable}</HelpTip>
    </div>
  );
}
