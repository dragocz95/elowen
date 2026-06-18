'use client';
export const dynamic = 'force-dynamic';
import { useMissions } from '../../lib/queries';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { MissionsView } from '../../modules/missions/MissionsView';

export default function MissionsPage() {
  const missions = useMissions();
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="missions">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.missions} count={missions.data?.length} />
        <MissionsView />
      </div>
    </ModuleShell>
  );
}
