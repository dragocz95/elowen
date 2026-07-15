'use client';
import { PluginIcon } from './PluginIcon';
import { PluginActions } from './PluginActions';
import { Badge } from '../../components/ui/Badge';
import { useTranslation } from '../../lib/i18n';
import type { PluginDetail } from '../../lib/types';

/** Hero: the plugin's identity card — icon, name, description, live enable toggle, and key facts. */
export function PluginHero({ name, detail, description, toolCount }: { name: string; detail: PluginDetail; description: string; toolCount: number }) {
  const { t } = useTranslation();
  const icon = <PluginIcon name={detail.name} hasIcon={detail.hasIcon} size={64} />;
  return (
    <section className="@container">
      <div className="flex flex-col gap-5 @2xl:flex-row @2xl:items-start">
        <div className="flex min-w-0 flex-1 gap-4">
          <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden text-accent">{icon}</div>
          <div className="min-w-0 pt-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl font-semibold tracking-[-0.025em] text-text">{detail.name}</h2>
              <Badge tone={detail.enabled ? 'success' : 'muted'}>{detail.enabled ? t.pluginDetail.statusEnabled : t.pluginDetail.statusDisabled}</Badge>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-text-muted">{description}</p>
          </div>
        </div>
        <div className="shrink-0 @2xl:pt-1"><PluginActions name={name} detail={detail} /></div>
      </div>
      <dl className="mt-5 flex flex-wrap gap-2">
        {[
          { term: t.pluginDetail.overviewVersion, value: `v${detail.version}`, mono: true },
          { term: t.pluginDetail.overviewSource, value: detail.source === 'bundled' ? t.plugins.bundled : t.plugins.user, mono: false },
          { term: t.pluginDetail.tools, value: String(toolCount), mono: true },
        ].map((fact) => (
          <div key={fact.term} className="inline-flex items-center gap-2 rounded-full border border-border bg-white/[0.012] px-3 py-1.5">
            <dt className="text-[9px] font-semibold uppercase tracking-[0.12em] text-text-muted">{fact.term}</dt>
            <dd className={`text-xs text-text ${fact.mono ? 'font-mono' : ''}`}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
