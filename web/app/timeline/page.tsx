'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { TimelineView } from '../../modules/timeline/TimelineView';

export default function TimelinePage() {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="timeline">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.timeline} />
        <TimelineView />
      </div>
    </ModuleShell>
  );
}
