'use client';
export const dynamic = 'force-dynamic';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { AccountView } from '../../modules/account/AccountView';

export default function AccountPage() {
  return (
    <ModuleShell moduleId="account">
      <AccountView />
    </ModuleShell>
  );
}
