'use client';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { UsersView } from '../../modules/users/UsersView';

export default function UsersPage() {
  return (
    <ModuleShell moduleId="users">
      <UsersView />
    </ModuleShell>
  );
}
