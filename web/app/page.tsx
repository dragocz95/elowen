'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LoadingLine } from '../components/ui/states';

/** The root path is a pure redirect into the shell. Setup itself belongs to the terminal installer, so an
 *  install that never finished is caught by the auth gate (no account to sign in as) rather than routed
 *  anywhere special here; a signed-in owner whose config is incomplete gets the dashboard's finish-setup
 *  nudge instead. */
export default function Home() {
  const router = useRouter();

  useEffect(() => { router.replace('/dash'); }, [router]);

  return (
    <main className="text-muted-foreground">
      <LoadingLine layout="page" />
    </main>
  );
}
