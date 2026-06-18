'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { SessionsView } from '../../modules/sessions/SessionsView';

export default function SessionsPage() {
  return (
    <ModuleShell moduleId="sessions">
      <SessionsView />
    </ModuleShell>
  );
}
