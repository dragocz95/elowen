import { useState } from 'react';
import { Check, Copy, ShieldCheck, TriangleAlert } from 'lucide-react';
import { IconButton } from '../../components/ui/IconButton';
import { SettingsGroup } from '../../components/ui/SettingsSurface';
import { useTranslation } from '../../lib/i18n';
import { useSystemReadiness } from '../../lib/queries';
import type { ReadinessCheck } from '../../lib/types';

/** One transcribable value with a copy affordance. Copying matters more than it looks: these are DNS
 *  records and console values retyped by hand into somebody else's control panel, where a single wrong
 *  character produces no error message anywhere — just a feature that stays dark. */
function FixValue({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={value}>{value}</code>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? t.pluginDetail.statusCopied : t.pluginDetail.statusCopy}
        onClick={copy}
      />
    </div>
  );
}

function StatusRow({ check }: { check: ReadinessCheck }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="mt-0.5 shrink-0" aria-hidden>
        {check.ok
          ? <Check size={15} className="text-success" strokeWidth={2.5} />
          : <TriangleAlert size={15} className="text-warning" strokeWidth={2} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-sm font-medium text-foreground">{check.label}</span>
          {/* The detail carries the actual failure text, which for a failing subsystem is the only
              place the real cause ever appears — never truncate it away. */}
          <span className={`min-w-0 text-xs ${check.ok ? 'text-muted-foreground' : 'text-warning'}`}>{check.detail}</span>
        </div>
        {!check.ok && check.hint ? <p className="text-xs text-muted-foreground">{check.hint}</p> : null}
        {!check.ok && check.fix?.length ? (
          <div className="flex flex-col gap-1.5 pt-0.5">
            {check.fix.map((entry) => <FixValue key={entry.label} label={entry.label} value={entry.value} />)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The plugin's own health, rendered where somebody configuring it is already looking.
 *
 *  It reads the SAME `registerReadinessCheck` rows the onboarding report reads — deliberately, rather
 *  than growing a second health endpoint that would drift from the first. A plugin that registers no
 *  check renders nothing at all, so this never becomes an empty card on every plugin. */
export function PluginStatusPanel({ name }: { name: string }) {
  const { t } = useTranslation();
  const readiness = useSystemReadiness();
  const checks = (readiness.data?.checks ?? []).filter((check) => check.plugin === name);
  if (checks.length === 0) return null;

  const failing = checks.filter((check) => !check.ok).length;
  return (
    <SettingsGroup
      className="plugin-card"
      icon={ShieldCheck}
      title={t.pluginDetail.statusTitle}
      description={t.pluginDetail.statusHint}
      actions={(
        <span className={`text-xs font-medium ${failing ? 'text-warning' : 'text-success'}`}>
          {failing ? t.pluginDetail.statusProblem.replace('{n}', String(failing)) : t.pluginDetail.statusOk}
        </span>
      )}
    >
      <div className="settings-group__panel flex flex-col gap-3">
        {checks.map((check) => <StatusRow key={check.id} check={check} />)}
      </div>
    </SettingsGroup>
  );
}
