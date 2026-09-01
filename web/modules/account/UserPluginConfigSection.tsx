'use client';

import { Settings2 } from 'lucide-react';
import { useEffect } from 'react';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { SettingsGroup } from '../../components/ui/SettingsSurface';
import { useTranslation } from '../../lib/i18n';
import { useSaveUserPluginConfig } from '../../lib/mutations';
import type { UserPluginConfigDetail } from '../../lib/types';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { usePluginConfigDraft } from '../../lib/usePluginConfigDraft';
import { PluginConfigEditor } from '../settings/PluginConfigEditor';

export function UserPluginConfigSection({ detail, onSaveState }: {
  detail: UserPluginConfigDetail;
  onSaveState: (status: SaveStatus, retry?: () => Promise<void>) => void;
}) {
  const { t, locale } = useTranslation();
  const save = useSaveUserPluginConfig();
  const editorDetail = { ...detail, configSchema: detail.userConfigSchema };
  const draft = usePluginConfigDraft(detail.name, editorDetail, {
    save: ({ name, values, expectedRevision }) => save.mutateAsync({ name, values, expectedRevision }),
  });
  const translated = detail.i18n?.[locale];
  const fieldLabel = (field: UserPluginConfigDetail['userConfigSchema'][number]) => translated?.fields?.[field.key]?.label ?? field.label;
  const fieldHint = (field: UserPluginConfigDetail['userConfigSchema'][number]) => translated?.fields?.[field.key]?.hint ?? field.hint;
  const fieldOptions = (field: UserPluginConfigDetail['userConfigSchema'][number]) => (field.options ?? []).map((option) => ({
    ...option,
    label: translated?.fields?.[field.key]?.options?.[option.value] ?? option.label,
  }));
  useEffect(() => { onSaveState(draft.status, draft.retry); }, [draft.retry, draft.status, onSaveState]);
  return (
    <>
      <SettingsGroup
        title={detail.description ?? detail.name}
        description={t.account.personalPluginConfig}
        icon={Settings2}
        actions={(
          <AutoSaveStatus
            status={draft.status}
            errorKind={draft.errorKind ?? undefined}
            onRetry={draft.errorKind === 'transport' ? draft.retry : undefined}
            onReload={draft.errorKind === 'conflict' ? () => draft.resolveConflict('reload') : undefined}
            onMerge={draft.errorKind === 'conflict' ? () => draft.resolveConflict('merge') : undefined}
          />
        )}
      >
        <PluginConfigEditor
          name={detail.name}
          detail={editorDetail}
          fieldLabel={fieldLabel}
          fieldHint={fieldHint}
          fieldOptions={fieldOptions}
          riskText={(risk) => risk === 'high' ? t.pluginDetail.riskHigh : risk === 'medium' ? t.pluginDetail.riskMedium : t.pluginDetail.riskLow}
          draft={draft}
          mode="all"
          showAppPackage={false}
        />
      </SettingsGroup>
    </>
  );
}
