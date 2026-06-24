'use client';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useGithubStatus } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';

/** Live banner at the top of the GitHub settings section: tells the operator whether a PR-native push
 *  would actually succeed (and as whom), so the token field's necessity is obvious at a glance. Reads
 *  the same `/integrations/github-status` probe the install wizard uses — one source of truth. */
export function GithubStatusBanner() {
  const { t } = useTranslation();
  const { data, isLoading } = useGithubStatus();
  if (isLoading || !data) return null;

  const ready = data.ready;
  const Icon = ready ? CheckCircle2 : AlertTriangle;
  const tone = ready
    ? 'border-success/40 bg-success/[0.08] text-success'
    : 'border-warning/40 bg-warning/[0.08] text-warning';

  const message = !ready
    ? t.settings.ghStatusNone
    : data.method === 'token'
      ? t.settings.ghStatusToken
      : data.account
        ? t.settings.ghStatusGh.replace('{account}', data.account)
        : t.settings.ghStatusGhNoAccount;

  return (
    <div className={`sm:col-span-2 flex items-start gap-2.5 rounded-lg border px-4 py-3 ${tone}`}>
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5 text-sm">
        <span className="font-medium">{message}</span>
        {!ready && <span className="text-text-muted">{t.settings.ghStatusNoneHint}</span>}
      </div>
    </div>
  );
}
