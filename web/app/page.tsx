'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCliStatus } from '../lib/queries';
import { useTranslation } from '../lib/i18n';

export default function Home() {
  const router = useRouter();
  const cliStatus = useCliStatus();
  const { t } = useTranslation();

  useEffect(() => {
    if (cliStatus.isLoading) return;
    if (cliStatus.data?.freshInstall?.noConfigPersisted) {
      router.replace('/onboarding');
    } else {
      router.replace('/dash');
    }
  }, [cliStatus.data, cliStatus.isLoading, router]);

  return (
    <main className="flex h-screen items-center justify-center text-text-muted">
      <span className="animate-pulse text-xs">{t.common.loading}</span>
    </main>
  );
}
