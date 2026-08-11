'use client';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

/** Client redirect for a core route whose UI moved into a plugin bundle: replaces the URL (no history
 *  entry) and carries the query string over, so deep links like /sessions?filter=needs_input land on
 *  the plugin page intact. When the plugin is disabled, the /p/<plugin> host page renders its
 *  unavailable placeholder — the redirect itself needs no availability check. */
export function PluginRedirect({ to }: { to: string }) {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const qs = params.toString();
    router.replace(qs ? `${to}?${qs}` : to);
  }, [router, params, to]);
  return null;
}
