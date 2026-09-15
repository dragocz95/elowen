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
    prompt: t.plugins.grantPrompt,
    events: t.plugins.grantEvents,
    'workflow-dag': t.plugins.grantWorkflowDag,
  };
  return grants.map((g) => known[g] ?? g);
}

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];

/** A dependency refusal already carries a sentence written for the reader, which is what makes it safe to
 *  show verbatim. Its own type, because every other failure must keep the generic wording: a raw daemon
 *  message in a toast is how internals reach a screen that was never meant to carry them. */
export class PluginDependencyError extends Error {}

/** A 409 naming controls is NOT a question — there is nothing for the reader to approve, only another
 *  plugin to switch on or off first. Turned into a sentence here so every surface reports it the same way,
 *  instead of showing a raw `missing plugin dependency` or a generic "changing the plugin failed".
 *
 *  Both directions arrive on the same shape, told apart by which side of the dependency the body names:
 *  `providedBy` is the enable refusal (turn that one on first), `requiredBy` is the disable and remove
 *  refusal (turn that one off first). Exported because removal is refused from a screen that has no
 *  consent dialog and would otherwise report the daemon's reason as an unexplained failure. */
export function pluginDependencyError(t: ReturnType<typeof useTranslation>['t'], e: unknown): PluginDependencyError | null {
  if (!(e instanceof ElowenApiError) || e.status !== 409) return null;
  const controls = e.details?.controls;
  if (!Array.isArray(controls) || controls.length === 0) return null;
  const parts = controls.map((entry) => {
    const item = entry as { key?: unknown; providedBy?: unknown; requiredBy?: unknown };
    const key = typeof item.key === 'string' ? item.key : '';
    if (!key) return null;
    const dependants = names(item.requiredBy);
    if (dependants.length > 0) {
      return t.plugins.dependencyInUse.replaceAll('{plugin}', dependants.join(', ')).replace('{control}', key);
    }
    const providers = names(item.providedBy);
    return providers.length > 0
      ? t.plugins.dependencyOn.replace('{plugin}', providers.join(', ')).replace('{control}', key)
      : t.plugins.dependencyMissing.replace('{control}', key);
  }).filter((line): line is string => line !== null);
  return parts.length > 0 ? new PluginDependencyError(parts.join(' ')) : null;
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

  const dependencyError = (e: unknown): PluginDependencyError | null => pluginDependencyError(t, e);

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
