'use client';
export const dynamic = 'force-dynamic';
import { LayoutDashboard } from 'lucide-react';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { useTranslation } from '../../lib/i18n';
import { DashboardView } from '../../modules/dashboard/DashboardView';

export default function DashPage() {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="dashboard">
      <ModuleHeader title={t.page.dashboard} icon={LayoutDashboard} />
      <DashboardView />
    </ModuleShell>
  );
}
