import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { runtime } from '../runtime';

interface GithubAuthStatus {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  account: string | null;
  tokenSet: boolean;
  ready: boolean;
  method: 'token' | 'gh' | 'none';
}

/** Live banner at the top of the GitHub settings section: tells the operator whether a PR-native push
 *  would actually succeed (and as whom), so the token field's necessity is obvious at a glance. Reads
 *  the plugin's own `/integrations/github-status` probe — the same one the install wizard uses. A
 *  failed probe renders nothing: the rows below still work, and a red banner about a status endpoint
 *  would explain less than the field it sits above.
 *
 *  The probe re-runs whenever the plugin's stored config is re-read. Saving a token invalidates that
 *  cache entry, so the banner learns about the save on the same refetch the token row does — without
 *  it the section would show "•••••••• saved" above "no GitHub sign-in" until a full page reload. */
export function GithubStatusBanner() {
  const { hooks, api } = runtime();
  const s = hooks.usePluginStrings('agents');
  const [data, setData] = useState<GithubAuthStatus | null>(null);
  const detail = hooks.usePluginDetail('agents');
  const configReadAt = detail.dataUpdatedAt;

  useEffect(() => {
    let alive = true;
    api('/integrations/github-status')
      .then((d) => { if (alive) setData(d as GithubAuthStatus); })
      .catch(() => { /* probe unavailable — the section renders without the banner */ });
    return () => { alive = false; };
  }, [api, configReadAt]);

  if (!data) return null;

  const ready = data.ready;
  const Icon = ready ? CheckCircle2 : AlertTriangle;
  const tone = ready
    ? 'text-success'
    : 'text-warning';

  const message = !ready
    ? s.ghStatusNone
    : data.method === 'token'
      ? s.ghStatusToken
      : data.account
        ? s.ghStatusGh?.replace('{account}', data.account)
        : s.ghStatusGhNoAccount;

  return (
    <div className={`settings-status-banner ${tone}`}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{message}</span>
        {!ready && <span className="text-text-muted">{s.ghStatusNoneHint}</span>}
      </div>
    </div>
  );
}
