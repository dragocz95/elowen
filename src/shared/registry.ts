/** Fetch orcasynth's latest published version from the npm registry, or null on ANY failure (network
 *  error, non-OK status, missing field). Single source for both the daemon's System panel
 *  (api/version.ts, which wraps it in a 30-min cache) and the self-updater (cli/update.ts, which treats
 *  null as "can't tell → no-op", so a transient registry blip never reddens the hourly update timer). */
export async function fetchLatestVersion(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchFn('https://registry.npmjs.org/orcasynth/latest');
    if (!r.ok) return null;
    const body = await r.json() as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}
