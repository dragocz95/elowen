'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { TimelineView } from '../../modules/timeline/TimelineView';

export default function TimelinePage() {
  return (
    <ModuleShell moduleId="timeline">
      <TimelineView />
    </ModuleShell>
  );
}
