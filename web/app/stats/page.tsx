'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { StatsView } from '../../modules/stats/StatsView';

export default function StatsPage() {
  return (
    <ModuleShell moduleId="stats">
      <StatsView />
    </ModuleShell>
  );
}
