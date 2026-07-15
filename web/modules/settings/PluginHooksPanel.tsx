'use client';
import { Webhook } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { SettingsGroup } from './SettingsSurface';
import { EmptyState } from '../../components/ui/states';
import type { Tone } from '../../components/ui/tone';
import { useTranslation } from '../../lib/i18n';
import type { PluginContributions, PluginHookExecution, PluginHookExecutions } from '../../lib/types';
import { namePill } from './pluginDetail.shared';

/** Hook-execution outcome → Badge tone: accepted patch is success, fail-open (threw/timeout) is danger,
 *  a capability-gate rejection is a warning (expected deny, not a fault). */
const OUTCOME_TONE: Record<PluginHookExecution['outcome'], Tone> = { ok: 'success', threw: 'danger', timeout: 'danger', rejected: 'warning' };

/** Hooks panel: the plugin's registered runtime hooks (subscriptions) + a recent-execution audit. */
export function PluginHooksPanel({ contributions, hookExecutions }: { contributions?: PluginContributions; hookExecutions?: PluginHookExecutions }) {
  const { t, locale } = useTranslation();
  const outcomeText = (o: PluginHookExecution['outcome']) =>
    o === 'ok' ? t.pluginDetail.outcomeOk
      : o === 'threw' ? t.pluginDetail.outcomeThrew
        : o === 'timeout' ? t.pluginDetail.outcomeTimeout
          : t.pluginDetail.outcomeRejected;
  return (
    <SettingsGroup className="plugin-card" icon={Webhook} title={t.pluginDetail.hooks} description={t.pluginDetail.hooksHint}>
      <div className="settings-group__panel flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          {(contributions?.hooks.length ?? 0) === 0 ? (
            <EmptyState title={t.pluginDetail.hooksEmpty} icon={Webhook} />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(contributions?.hooks ?? []).map((h, i) => <span key={`${h.name}-${i}`} className={namePill}>{h.name}</span>)}
            </div>
          )}
        </div>
        {/* Recent-execution audit: only shown once at least one hook has actually run — an empty audit
            is noise (no bundled plugin registers hooks), so the panel stays hidden until there's data. */}
        {hookExecutions && hookExecutions.entries.length > 0 ? (
          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.hookExecutions}</span>
            <p className="text-xs text-text-muted">{t.pluginDetail.hookExecutionsHint}</p>
            <div className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-3 text-[11px] leading-relaxed">
              {hookExecutions.entries.map((e, i) => (
                <div key={i} className="flex items-center gap-2 py-1">
                  <span className="shrink-0 font-mono text-text-muted">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-text">{e.hook}</span>
                  {e.changed ? <span className="shrink-0 font-mono text-text-muted">{e.changed}</span> : null}
                  <span className="shrink-0 font-mono text-text-muted">{`${e.durationMs} ms`}</span>
                  <Badge tone={OUTCOME_TONE[e.outcome]}>{outcomeText(e.outcome)}</Badge>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}
