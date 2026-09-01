'use client';
import { LayoutDashboard } from 'lucide-react';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { useTranslation } from '../../lib/i18n';
import { DashboardView } from '../../modules/dashboard/DashboardView';
import type { DashRecap } from '../../lib/types';

/** The client half of /dash. It exists only so the route itself can be a server component and prefetch
 *  the recap: the shell, the header title and the view are all client-side, and the seed passes
 *  straight through to the hero. */
export function DashPageBody({ recapSeed }: { recapSeed: DashRecap | null }) {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="dashboard">
      <ModuleHeader title={t.page.dashboard} icon={LayoutDashboard} />
      <DashboardView recapSeed={recapSeed} />
    </ModuleShell>
  );
}
