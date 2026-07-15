'use client';
import { KeyRound, ShieldCheck, Globe } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { SettingsGroup } from './SettingsSurface';
import type { Tone } from '../../components/ui/tone';
import { useTranslation } from '../../lib/i18n';
import type { PluginConfigField, PluginDetail } from '../../lib/types';
import { RISK_TONE, CONNECTION_KEYS, namePill } from './pluginDetail.shared';

/** Mutation target → Badge tone by blast radius: tools/memory reach beyond the turn (danger),
 *  prompt/turnContext ride only the ephemeral live prompt (warning). */
const MUTATE_TONE: Record<'prompt' | 'turnContext' | 'tools' | 'memory', Tone> = { prompt: 'warning', turnContext: 'warning', tools: 'danger', memory: 'danger' };

/** Permissions panel: derived requirements + risk summary (read-only). */
export function PluginPermissionsPanel({ detail, fieldLabel, riskText, toolCount, platformCount }: {
  detail: PluginDetail;
  fieldLabel: (f: PluginConfigField) => string;
  riskText: (r: 'low' | 'medium' | 'high') => string;
  toolCount: number;
  platformCount: number;
}) {
  const { t } = useTranslation();
  const schema = detail.configSchema;

  // Permissions derived from what EXISTS in the manifest — required secret fields read as credential
  // requirements, the rest as plain config; a coarse risk level from secrets/network/tool-count.
  const requiredSecrets = schema.filter((f) => f.required && f.type === 'secret');
  const requiredConfig = schema.filter((f) => f.required && f.type !== 'secret' && f.type !== 'section');
  const hasSecrets = schema.some((f) => f.type === 'secret') || detail.secretsSet.length > 0;
  const declaresNetwork = schema.some((f) => CONNECTION_KEYS.has(f.key)) || platformCount > 0;
  const anyHighRiskField = schema.some((f) => f.risk === 'high');
  const riskLevel: 'low' | 'medium' | 'high' =
    anyHighRiskField || (hasSecrets && (declaresNetwork || toolCount > 3)) ? 'high'
      : hasSecrets || declaresNetwork || toolCount > 0 ? 'medium'
        : 'low';

  // Declared manifest capabilities — deny-by-default: an absent target means the plugin CANNOT do it.
  const capabilities = detail.capabilities ?? {};
  const mutates = capabilities.mutates ?? [];
  const reads = capabilities.reads ?? [];
  const hasCapabilities = mutates.length > 0 || reads.length > 0 || capabilities.network === true;

  return (
    <SettingsGroup className="plugin-card" icon={ShieldCheck} title={t.pluginDetail.permissions} description={t.pluginDetail.permissionsHint}>
      <div className="settings-group__panel flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={RISK_TONE[riskLevel]}>{riskText(riskLevel)}</Badge>
          {hasSecrets ? <Badge tone="accent"><KeyRound size={10} className="mr-1" aria-hidden />{t.brain.keySet}</Badge> : null}
          {declaresNetwork ? <Badge><Globe size={10} className="mr-1" aria-hidden />{t.pluginDetail.platforms}</Badge> : null}
          {toolCount > 0 ? <Badge>{`${toolCount} ${t.pluginDetail.tools}`}</Badge> : null}
        </div>
        {/* Declared manifest capabilities — the deny-by-default permission surface. Shown only when the
            plugin actually declares something; an absent declaration means "cannot do anything", so an
            empty panel carries no information and stays hidden. */}
        {hasCapabilities ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-bg p-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.capabilities}</span>
            <p className="text-xs text-text-muted">{t.pluginDetail.capabilitiesDeny}</p>
            <div className="flex flex-col gap-2">
              {mutates.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capMutates}</span>
                  {mutates.map((m) => <Badge key={m} tone={MUTATE_TONE[m]}>{m}</Badge>)}
                </div>
              ) : null}
              {capabilities.network === true ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capNetwork}</span>
                  <Badge tone="warning"><Globe size={10} className="mr-1" aria-hidden />{t.pluginDetail.capNetworkOn}</Badge>
                </div>
              ) : null}
              {reads.length ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-text-muted">{t.pluginDetail.capReads}</span>
                  {reads.map((r) => <span key={r} className={namePill}>{r}</span>)}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {requiredSecrets.length === 0 && requiredConfig.length === 0 ? (
          <p className="text-sm text-text-muted">{t.pluginDetail.requiresNone}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {requiredSecrets.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.requiresEnv}</span>
                <div className="flex flex-wrap gap-1.5">{requiredSecrets.map((f) => <span key={f.key} className={namePill}>{fieldLabel(f)}</span>)}</div>
              </div>
            ) : null}
            {requiredConfig.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t.pluginDetail.requiresConfig}</span>
                <div className="flex flex-wrap gap-1.5">{requiredConfig.map((f) => <span key={f.key} className={namePill}>{fieldLabel(f)}</span>)}</div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}
