'use client';
import { useEffect, useState } from 'react';
import { useHermesStatus } from '../../lib/queries';
import { useHermesInstall } from '../../lib/mutations';

/** Shared Hermes install-form state, used by both the Settings panel and the Onboarding wizard so the
 *  home/url/token fields, the live plugin-status query and the install mutation live in one place
 *  (they were copy-pasted across both pages — finding W2). The url is pre-filled from this origin; the
 *  token is entered manually (the session token now lives in an httpOnly cookie JS can't read, and a
 *  long-lived external integration should use its own minted token anyway). Each page renders its own layout. */
export function useHermesForm() {
  const [home, setHome] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const status = useHermesStatus(home);
  const install = useHermesInstall();

  // Pre-fill the URL once on the client from this origin. Client-only — window isn't on the server.
  useEffect(() => {
    setUrl(window.location.origin);
  }, []);

  return { home, setHome, url, setUrl, token, setToken, status, install };
}
