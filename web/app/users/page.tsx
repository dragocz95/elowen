'use client';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { UsersPanel } from '../../modules/users/UsersPanel';

export default function UsersPage() {
  return (
    <ModuleShell moduleId="users">
      <Panel>
        <PageHeader title="Users" />
        <UsersPanel />
      </Panel>
    </ModuleShell>
  );
}
