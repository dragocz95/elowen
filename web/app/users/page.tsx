'use client';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { PageHeader } from '../../components/ui/PageHeader';
import { useTranslation } from '../../lib/i18n';
import { UsersPanel } from '../../modules/users/UsersPanel';

export default function UsersPage() {
  const { t } = useTranslation();
  return (
    <ModuleShell moduleId="users">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.users} />
        <UsersPanel />
      </div>
    </ModuleShell>
  );
}
