'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { MissionsView } from '../../modules/missions/MissionsView';

export default function MissionsPage() {
  return (
    <ModuleShell moduleId="missions">
      <MissionsView />
    </ModuleShell>
  );
}
