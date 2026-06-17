'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { DashboardView } from '../../modules/dashboard/DashboardView';

export default function DashPage() {
  return (
    <ModuleShell moduleId="dashboard">
      <DashboardView />
    </ModuleShell>
  );
}
