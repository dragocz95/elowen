'use client';
import { useState, type ReactNode } from 'react';
import { ElowenApiError } from '../../lib/elowenClient';
import { useInstallPlugin, useTogglePlugin } from '../../lib/mutations';
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

type Pending = { name: string; grants: string[]; kind: 'enable' | 'install' };

/** The two ways a plugin's powers can become real — the enable toggle and a marketplace install — behind
 *  one consent dialog.
 *
 *  The daemon refuses either until the caller names the powers that outlive a turn (409 + the list). That
 *  refusal is not an error to report, it is the question to ask: it opens a dialog naming what is being
 *  handed over, and the answer replays the SAME operation with the acknowledgement. An install refused
 *  this way has already landed on disk, inert — cancelling leaves it installed but switched off, which is
 *  why the confirm replays the install rather than starting over. */
export function usePluginConsent(opts: {
  onSuccess?: (res: PluginInfo & { pending?: boolean }) => void;
  onError?: (e: unknown) => void;
  onInstalled?: (res: PluginInfo & { pending?: boolean }) => void;
  onInstallError?: (e: unknown) => void;
  onSettled?: () => void;
}) {
  const toggle = useTogglePlugin();
  const install = useInstallPlugin();
  const { t } = useTranslation();
  const [asking, setAsking] = useState<Pending | null>(null);

  /** A 409 naming missing controls is NOT a question - there is nothing for the reader to approve, only
   *  another plugin to turn on first. Turned into a sentence here so every caller of this hook reports it
   *  the same way, instead of showing a raw `missing plugin dependency`. */
  const dependencyError = (e: unknown): Error | null => {
    if (!(e instanceof ElowenApiError) || e.status !== 409) return null;
    const controls = e.details?.controls;
    if (!Array.isArray(controls) || controls.length === 0) return null;
    const parts = controls.map((entry) => {
      const item = entry as { key?: unknown; providedBy?: unknown };
      const key = typeof item.key === 'string' ? item.key : '';
      const providers = Array.isArray(item.providedBy)
        ? item.providedBy.filter((n): n is string => typeof n === 'string')
        : [];
      if (!key) return null;
      return providers.length > 0
        ? t.plugins.dependencyOn.replace('{plugin}', providers.join(', ')).replace('{control}', key)
        : t.plugins.dependencyMissing.replace('{control}', key);
    }).filter((line): line is string => line !== null);
    return parts.length > 0 ? new Error(parts.join(' ')) : null;
  };

  /** A 409 that names powers is the consent question; anything else is a genuine failure. */
  const askedGrants = (e: unknown): string[] | null => {
    const grants = e instanceof ElowenApiError && e.status === 409 ? e.details?.grants : undefined;
    return Array.isArray(grants) && grants.every((g): g is string => typeof g === 'string') ? grants : null;
  };

  const setEnabled = (name: string, enabled: boolean, acknowledgeGrants?: string[]) => {
    toggle.mutate({ name, enabled, ...(acknowledgeGrants ? { acknowledgeGrants } : {}) }, {
      onSuccess: (res) => { setAsking(null); opts.onSuccess?.(res); },
      onError: (e) => {
        const grants = askedGrants(e);
        if (grants) { setAsking({ name, grants, kind: 'enable' }); return; }
        opts.onError?.(dependencyError(e) ?? e);
      },
    });
  };

  const installPlugin = (name: string, acknowledgeGrants?: string[]) => {
    install.mutate({ name, ...(acknowledgeGrants ? { acknowledgeGrants } : {}) }, {
      onSuccess: (res) => { setAsking(null); opts.onInstalled?.(res); },
      onError: (e) => {
        const grants = askedGrants(e);
        if (grants) { setAsking({ name, grants, kind: 'install' }); return; }
        opts.onInstallError?.(dependencyError(e) ?? e);
      },
      onSettled: () => opts.onSettled?.(),
    });
  };

  const confirm = async () => {
    const current = asking;
    if (!current) return;
    try {
      if (current.kind === 'install') {
        const result = await install.mutateAsync({ name: current.name, acknowledgeGrants: current.grants });
        setAsking(null);
        opts.onInstalled?.(result);
      } else {
        const result = await toggle.mutateAsync({ name: current.name, enabled: true, acknowledgeGrants: current.grants });
        setAsking(null);
        opts.onSuccess?.(result);
      }
    } catch (e) {
      const grants = askedGrants(e);
      if (grants) {
        setAsking({ name: current.name, grants, kind: current.kind });
      } else {
        (current.kind === 'install' ? opts.onInstallError : opts.onError)?.(dependencyError(e) ?? e);
      }
      throw e;
    } finally {
      if (current.kind === 'install') opts.onSettled?.();
    }
  };

  const dialog: ReactNode = asking ? (
    <ConfirmDialog
      open
      title={t.plugins.grantsTitle.replace('{name}', asking.name)}
      description={`${t.plugins.grantsIntro}\n\n${grantLabels(t, asking.grants).map((g) => `• ${g}`).join('\n')}`}
      confirmLabel={t.plugins.grantsConfirm}
      onConfirm={confirm}
      onClose={() => setAsking(null)}
    />
  ) : null;

  return {
    setEnabled,
    install: installPlugin,
    dialog,
    isBusy: (name: string) => toggle.isPending && toggle.variables?.name === name,
  };
}
