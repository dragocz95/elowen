'use client';
import { Bot, Check, Clock3, MessageCircle, TerminalSquare, Wrench } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { PluginIcon } from './PluginIcon';
import { useTranslation } from '../../lib/i18n';
import type { PluginConfigField, PluginDetail } from '../../lib/types';

// One shared surface for every preview tile so the panel reads as a single clean card language instead of
// a mix of accent-bordered, elevated and surface boxes.
const previewBox = 'rounded-lg border border-border/70 bg-white/[0.02] px-3 py-2.5';

function valueOf(detail: PluginDetail, values: Record<string, unknown>, key: string): unknown {
  if (values[key] !== undefined) return values[key];
  return detail.configSchema.find((field) => field.key === key)?.default;
}

function OnOff({ on }: { on: boolean }) {
  const { t } = useTranslation();
  return <Badge tone={on ? 'success' : 'muted'}>{on ? t.settings.on : t.settings.off}</Badge>;
}

function DiscordPreview({ detail, values }: { detail: PluginDetail; values: Record<string, unknown> }) {
  const { t } = useTranslation();
  const tools = String(valueOf(detail, values, 'toolActivity') ?? 'status');
  const answer = String(valueOf(detail, values, 'answerMode') ?? 'final');
  const output = String(valueOf(detail, values, 'toolOutput') ?? 'summary');
  const perTool = String(valueOf(detail, values, 'toolMessageMode') ?? 'single') === 'per_tool';
  const outputPreview = output === 'hidden' ? null : output === 'tail' ? (
    <pre className="mt-1.5 whitespace-pre-wrap rounded-md bg-bg/70 px-2 py-1.5 text-[10px] leading-relaxed text-text">{'$ npm test\n✓ 42/42\n…'}</pre>
  ) : <span className="mt-1 block truncate text-[10px] text-text">✓ 42/42</span>;
  const bubble = (name: string, status: string, withOutput = false) => (
    <div data-testid="discord-tool-bubble" className={previewBox}>
      <div className="flex items-center gap-2 font-mono text-[11px] text-text-muted"><Wrench size={12} className="text-accent" aria-hidden /><span>{name}</span><span className="ml-auto">{status}</span></div>
      {withOutput ? outputPreview : null}
    </div>
  );
  const toolPanel = tools === 'off' ? (
    <div className={previewBox}>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-text"><Wrench size={13} className="text-accent" aria-hidden />{t.pluginDetail.previewToolActivity}</div>
      <span className="text-xs text-text-muted">{t.pluginDetail.previewHidden}</span>
    </div>
  ) : perTool ? (
    <div className="flex flex-col gap-2">
      {bubble('Bash', t.pluginDetail.previewRunning, output !== 'hidden')}
      {bubble('web_search', t.pluginDetail.previewDone)}
    </div>
  ) : (
    <div data-testid="discord-tool-bubble" className={previewBox}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-text"><Wrench size={13} className="text-accent" aria-hidden />{t.pluginDetail.previewToolActivity}</div>
      <div className="flex flex-col gap-1.5 font-mono text-[11px] text-text-muted">
        <span className="flex justify-between gap-2"><span>Bash</span><span>{t.pluginDetail.previewRunning}</span></span>
        {outputPreview}
        <span className="flex justify-between gap-2"><span>web_search</span><span>{t.pluginDetail.previewDone}</span></span>
      </div>
    </div>
  );
  return (
    <div className="@container">
      <div data-testid="discord-preview-layout" className="grid grid-cols-1 gap-2.5 @lg:grid-cols-[minmax(0,1.35fr)_minmax(0,.65fr)] @lg:items-stretch">
        {toolPanel}
        <div className={`${previewBox} text-xs leading-relaxed text-text`}>
          <span className="mb-1 block font-medium text-accent">Elowen</span>
          {answer === 'live' ? t.pluginDetail.previewStreamingAnswer : t.pluginDetail.previewFinalAnswer}
        </div>
      </div>
    </div>
  );
}

function WhatsAppPreview({ detail, values }: { detail: PluginDetail; values: Record<string, unknown> }) {
  const { t } = useTranslation();
  const streaming = valueOf(detail, values, 'streaming') !== false;
  const reasoning = valueOf(detail, values, 'showReasoning') === true;
  return (
    <div className="flex flex-col gap-2">
      <div className="ml-5 rounded-xl rounded-tr-sm bg-success/10 px-3 py-2.5 text-xs leading-relaxed text-text">
        {streaming ? t.pluginDetail.previewStreamingAnswer : t.pluginDetail.previewFinalAnswer}
      </div>
      <div className="flex items-center justify-end gap-2"><span className="text-tiny text-text-muted">{t.pluginDetail.previewReasoning}</span><OnOff on={reasoning} /></div>
    </div>
  );
}

function CronPreview({ detail, values }: { detail: PluginDetail; values: Record<string, unknown> }) {
  const { t } = useTranslation();
  const tick = Number(valueOf(detail, values, 'tickMs') ?? 30000) / 1000;
  const attempts = Number(valueOf(detail, values, 'retryAttempts') ?? 2);
  return (
    <div className="rounded-lg border border-border/70 bg-white/[0.02] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium text-text"><Clock3 size={15} className="text-accent" aria-hidden />{t.pluginDetail.previewScheduler}</div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <dt className="text-text-muted">{t.pluginDetail.previewCheckEvery}</dt><dd className="text-right font-mono text-text">{tick}s</dd>
        <dt className="text-text-muted">{t.pluginDetail.previewAttempts}</dt><dd className="text-right font-mono text-text">{attempts}</dd>
      </dl>
    </div>
  );
}

function TerminalPreview({ detail, values }: { detail: PluginDetail; values: Record<string, unknown> }) {
  const { t } = useTranslation();
  const cap = Number(valueOf(detail, values, 'outputCap') ?? 60000);
  const timeout = Number(valueOf(detail, values, 'commandTimeoutMs') ?? 120000) / 1000;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg font-mono text-[11px]">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-text-muted"><TerminalSquare size={13} aria-hidden />Bash</div>
      <div className="space-y-1 p-3 text-text"><div>$ npm test</div><div className="text-success">✓ {t.pluginDetail.previewDone}</div></div>
      <div className="border-t border-border px-3 py-2 text-text-muted">{Math.round(cap / 1000)} KB · {timeout}s</div>
    </div>
  );
}

function GenericPreview({ detail, values, fieldLabel }: { detail: PluginDetail; values: Record<string, unknown>; fieldLabel: (field: PluginConfigField) => string }) {
  const { t } = useTranslation();
  const fields = detail.configSchema.filter((field) => field.type !== 'section' && field.type !== 'secret').slice(0, 4);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3"><PluginIcon name={detail.name} hasIcon={detail.hasIcon} size={38} /><div><div className="text-sm font-medium text-text">{detail.name}</div><div className="text-xs text-text-muted">{detail.enabled ? t.pluginDetail.statusEnabled : t.pluginDetail.statusDisabled}</div></div></div>
      {fields.length ? <dl className="flex flex-col gap-2 border-t border-border pt-3">{fields.map((field) => {
        const raw = valueOf(detail, values, field.key);
        return <div key={field.key} className="flex items-center justify-between gap-3 text-xs"><dt className="truncate text-text-muted">{fieldLabel(field)}</dt><dd className="max-w-[50%] truncate font-mono text-text">{typeof raw === 'boolean' ? (raw ? t.settings.on : t.settings.off) : String(raw ?? '—')}</dd></div>;
      })}</dl> : <p className="text-xs text-text-muted">{t.pluginDetail.previewNoConfig}</p>}
    </div>
  );
}

/** Safe, manifest-driven preview. It only renders known UI templates and plain data; plugin packages
 *  never supply executable React code. */
export function PluginLivePreview({ detail, values, fieldLabel }: {
  detail: PluginDetail;
  values: Record<string, unknown>;
  fieldLabel: (field: PluginConfigField) => string;
}) {
  const { t } = useTranslation();
  const name = detail.name.toLowerCase();
  let body;
  if (name === 'discord') body = <DiscordPreview detail={detail} values={values} />;
  else if (name === 'whatsapp') body = <WhatsAppPreview detail={detail} values={values} />;
  else if (name === 'cronjob') body = <CronPreview detail={detail} values={values} />;
  else if (name === 'terminal') body = <TerminalPreview detail={detail} values={values} />;
  else if (name.includes('personality')) body = <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-white/[0.02] p-3 text-sm text-text"><Bot size={15} className="text-accent" aria-hidden />{t.pluginDetail.previewPersonality}</div>;
  else body = <GenericPreview detail={detail} values={values} fieldLabel={fieldLabel} />;
  return (
    <section aria-label={t.pluginDetail.livePreview} className="rounded-[var(--radius-lg)] border border-white/[0.075] bg-white/[0.012] p-4">
      <header className="mb-4 flex items-center justify-between gap-2"><span className="flex items-center gap-2 text-sm font-medium text-text"><MessageCircle size={15} className="text-accent" aria-hidden />{t.pluginDetail.livePreview}</span><span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.08em] text-success"><Check size={11} aria-hidden />{t.pluginDetail.previewLive}</span></header>
      {body}
    </section>
  );
}
