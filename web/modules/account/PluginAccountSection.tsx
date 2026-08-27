'use client';

import { useEffect, useState, type ComponentType } from 'react';
import type { PluginPageProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';

type AccountRegistration = PluginUiRegistration & {
  account?: Record<string, ComponentType<PluginPageProps>>;
  /** A connector's one-line claim for the CLOSED Linked accounts summary, keyed like `account`. It is a
   *  SEPARATE registration rather than a mode of the panel on purpose: a bundle that knows nothing about
   *  chips must render nothing in the summary, and any scheme where the host mounts the panel and asks it
   *  to behave differently gives the opposite default — the whole panel, inlined into a row of chips. */
  accountChip?: Record<string, ComponentType<PluginPageProps>>;
};
import { ErrorState, LoadingState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from '../../lib/pluginUi';
import type { PluginUiListing } from '../../lib/types';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { pluginAccountSectionId } from './pluginSections';

export function PluginAccountSection({ entry, sectionId, view = 'panel', onSaveState }: {
  entry: PluginUiListing;
  sectionId: string;
  /** `chip` renders the bundle's `accountChip` entry — its one-line claim in the closed Linked accounts
   *  summary ("GitHub" beside the chat platforms) — instead of the panel behind the drawer. Both mounts
   *  exist at once on the Account page; they share one react-query cache, so the connector's status is
   *  fetched once however many times it is asked. */
  view?: 'panel' | 'chip';
  onSaveState: (id: string, status: SaveStatus, retry?: () => void) => void;
}) {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<AccountRegistration | null | undefined>(undefined);
  const compatible = entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!compatible) return;
    let alive = true;
    void loadPluginUi(entry.name, entry.url, entry.cssUrl).then((value) => { if (alive) setRegistration(value); });
    return () => { alive = false; };
  }, [compatible, entry.cssUrl, entry.name, entry.url]);

  // A chip decorates a row that is already useful without it, so it never reports on the bundle behind
  // it: an "unavailable" notice sitting between working chips reads as a broken ACCOUNT rather than a
  // broken plugin, and a spinner there flickers on every visit to the page. The drawer this summarises
  // still states all three outcomes plainly — that is the surface where the reader asked.
  const quiet = view === 'chip';
  if (!compatible) return quiet ? null : <ErrorState message={t.pluginUi.incompatible} />;
  if (registration === undefined) return quiet ? null : <LoadingState />;
  if (registration === null) return quiet ? null : <ErrorState message={t.pluginUi.loadFailed} />;
  // A bundle with no chip registration simply has none: the summary loses a chip, never gains a panel
  // rendered sideways into a row of them.
  const Component = (quiet ? registration.accountChip?.[sectionId] : registration.account?.[sectionId]) as ComponentType<PluginPageProps> | undefined;
  if (!Component) return quiet ? null : <ErrorState message={t.pluginUi.settingsUnavailable} />;
  return (
    <Component
      plugin={entry.name}
      params={{ id: sectionId }}
      rest={[]}
      surface="deck"
      // A chip owns no setting, so it must not speak for the panel's save indicator: both mounts render
      // at once, and the chip reporting "saved" would overwrite what the drawer is actually doing.
      onSaveState={quiet ? () => {} : (status, retry) => onSaveState(pluginAccountSectionId(entry.name, sectionId), status, retry)}
    />
  );
}
