'use client';
export const dynamic = 'force-dynamic';
import { useSessions } from '../../lib/queries';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { SessionsView } from '../../modules/sessions/SessionsView';

export default function SessionsPage() {
  const sessions = useSessions();
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="sessions">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.sessions} count={sessions.data?.length} />
        <SessionsView />
      </div>
    </ModuleShell>
  );
}
