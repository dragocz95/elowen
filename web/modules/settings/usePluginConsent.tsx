'use client';
import { useState, type ReactNode } from 'react';
import { ElowenApiError } from '../../lib/elowenClient';
import { useTogglePlugin } from '../../lib/mutations';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useTranslation } from '../../lib/i18n';
import type { PluginInfo } from '../../lib/types';

/** Human sentences for the grants the daemon can refuse an enable over. Keyed by the id it sends, so an
 *  id this build does not know about still reaches the reader verbatim — a power shown as jargon is far
 *  better than a power silently dropped from the list it is being asked to approve. */
function grantLabels(t: ReturnType<typeof useTranslation>['t'], grants: string[]): string[] {
  const known: Record<string, string> = {
    tools: t.plugins.grantTools,
    memory: t.plugins.grantMemory,
    events: t.plugins.grantEvents,
    'workflow-dag': t.plugins.grantWorkflowDag,
  };
  return grants.map((g) => known[g] ?? g);
}

/** The enable/disable switch shared by the plugin list and the plugin detail.
 *
 *  Enabling is the moment a plugin's declared capabilities become real, so the daemon refuses to do it
 *  until the caller names the ones that outlive a turn (409 + the list). That refusal is not an error to
 *  report — it is the question to ask — so it opens a dialog naming what is being handed over, and the
 *  answer re-sends the same enable with the acknowledgement. Cancelling leaves the plugin off. */
export function usePluginConsent(opts: { onSuccess?: (res: PluginInfo & { pending?: boolean }) => void; onError?: (e: unknown) => void }) {
  const toggle = useTogglePlugin();
  const { t } = useTranslation();
  const [asking, setAsking] = useState<{ name: string; grants: string[] } | null>(null);

  const send = (name: string, enabled: boolean, acknowledgeGrants?: string[]) => {
    toggle.mutate({ name, enabled, ...(acknowledgeGrants ? { acknowledgeGrants } : {}) }, {
      onSuccess: (res) => { setAsking(null); opts.onSuccess?.(res); },
      onError: (e) => {
        const grants = e instanceof ElowenApiError && e.status === 409 ? e.details?.grants : undefined;
        // Only a refusal that actually names powers becomes a question; anything else is a real failure.
        if (Array.isArray(grants) && grants.every((g): g is string => typeof g === 'string')) {
          setAsking({ name, grants });
          return;
        }
        opts.onError?.(e);
      },
    });
  };

  const dialog: ReactNode = asking ? (
    <ConfirmDialog
      open
      title={t.plugins.grantsTitle.replace('{name}', asking.name)}
      description={`${t.plugins.grantsIntro}\n\n${grantLabels(t, asking.grants).map((g) => `• ${g}`).join('\n')}`}
      confirmLabel={t.plugins.grantsConfirm}
      onConfirm={() => send(asking.name, true, asking.grants)}
      onClose={() => setAsking(null)}
    />
  ) : null;

  return { setEnabled: send, dialog, isBusy: (name: string) => toggle.isPending && toggle.variables?.name === name };
}
