'use client';

import { Settings2 } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { SettingsDocument, SettingsGroup } from '../../components/ui/SettingsSurface';
import { useTranslation } from '../../lib/i18n';
import { useSaveUserPluginConfig } from '../../lib/mutations';
import type { UserPluginConfigDetail } from '../../lib/types';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { usePluginConfigDraft } from '../../lib/usePluginConfigDraft';
import { PluginConfigEditor } from '../settings/PluginConfigEditor';
import { userPluginConfigDescription, userPluginConfigLabel } from './userPluginConfigStrings';

export function UserPluginConfigSection({ sectionId, detail, onSaveStateAction }: {
  sectionId: string;
  detail: UserPluginConfigDetail;
  onSaveStateAction: (sectionId: string, status: SaveStatus, retry?: () => Promise<void>) => void;
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
  const onSaveStateRef = useRef(onSaveStateAction);
  useEffect(() => { onSaveStateRef.current = onSaveStateAction; }, [onSaveStateAction]);
  useEffect(() => { onSaveStateRef.current(sectionId, draft.status, draft.retry); }, [draft.retry, draft.status, sectionId]);
  return (
    // The plugin's name card and the sections it declares are SIBLINGS in one document, exactly like the
    // cards on any core settings page. Nesting the editor inside the name card is what welded the two into
    // a single bordered rectangle: a group body has no padding of its own and the card clips its children,
    // so the section card's border landed flush against the header's rule with no gap anywhere.
    <SettingsDocument>
      <SettingsGroup
        title={userPluginConfigLabel(detail, locale)}
        description={userPluginConfigDescription(detail, locale) ?? t.account.personalPluginConfig}
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
      />
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
    </SettingsDocument>
  );
}
