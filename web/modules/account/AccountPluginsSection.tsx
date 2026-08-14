'use client';
import { useEffect } from 'react';
import { Blocks } from 'lucide-react';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { useMyPluginConfigs } from '../../lib/queries';
import { useSaveMyPluginConfig } from '../../lib/mutations';
import { PluginConfigEditor } from '../settings/PluginConfigEditor';
import { usePluginConfigDraft } from '../settings/usePluginConfigDraft';
import type { PluginConfigField, PluginUserConfig } from '../../lib/types';

/** One plugin's per-ACCOUNT form. Rendered by the SAME schema-driven editor as the instance-wide plugin
 *  settings — a second form would be a second set of field behaviours to keep in step. `mode="all"`
 *  because the setup/behavior/advanced tabs belong to the settings workspace, not to a schema. */
function PluginUserForm({ plugin, onSaveState }: {
  plugin: PluginUserConfig;
  onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void;
}) {
  const { t, locale } = useTranslation();
  const save = useSaveMyPluginConfig();
  const tr = plugin.i18n?.[locale];
  const fieldLabel = (field: PluginConfigField) => tr?.fields?.[field.key]?.label ?? field.label;
  const fieldHint = (field: PluginConfigField) => tr?.fields?.[field.key]?.hint ?? field.hint;
  const fieldOptions = (field: PluginConfigField) => (field.options ?? []).map((option) => ({
    ...option,
    label: tr?.fields?.[field.key]?.options?.[option.value] ?? option.label,
  }));
  const riskText = (risk: 'low' | 'medium' | 'high') => risk === 'high' ? t.pluginDetail.riskHigh : risk === 'medium' ? t.pluginDetail.riskMedium : t.pluginDetail.riskLow;
  const detail = { name: plugin.name, configSchema: plugin.userConfigSchema, secretsSet: plugin.secretsSet, config: plugin.config };
  const draft = usePluginConfigDraft(plugin.name, detail, { save: (v) => save.mutateAsync(v) });
  useEffect(() => onSaveState?.('plugins', draft.status, draft.retry), [onSaveState, draft.status, draft.retry]);

  return (
    <SpatialRow
      title={plugin.name}
      icon={Blocks}
      description={tr?.description ?? plugin.description}
    >
      <PluginConfigEditor
        name={plugin.name}
        detail={detail}
        fieldLabel={fieldLabel}
        fieldHint={fieldHint}
        fieldOptions={fieldOptions}
        riskText={riskText}
        draft={draft}
        mode="all"
      />
    </SpatialRow>
  );
}

/** Account → Plugins: the caller's OWN values for every plugin that declares per-account fields (their
 *  API key, their identifier in an external system). The daemon derives the account from the session, so
 *  this surface can only ever show and write the signed-in user's own data — an admin sees their own
 *  values here, not everybody's. */
export function AccountPluginsSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void } = {}) {
  const { data, isLoading, isError, refetch } = useMyPluginConfigs();
  const { t } = useTranslation();

  if (isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
  if (isLoading || !data) return <LoadingState />;
  // Reachable only if a plugin's fields disappear while the section is open (a disable, a revoked grant):
  // the section itself is not offered for an empty list.
  if (data.length === 0) return <SpatialGroup><EmptyState title={t.account.pluginsEmpty} icon={Blocks} /></SpatialGroup>;

  return (
    <SpatialGroup>
      {data.map((plugin) => <PluginUserForm key={plugin.name} plugin={plugin} onSaveState={onSaveState} />)}
    </SpatialGroup>
  );
}
