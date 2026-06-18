'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { DashboardView } from '../../modules/dashboard/DashboardView';

export default function DashPage() {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="dashboard">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.dashboard} />
        <DashboardView />
      </div>
    </ModuleShell>
  );
}
