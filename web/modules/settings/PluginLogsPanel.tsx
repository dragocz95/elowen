'use client';
import { ScrollText } from 'lucide-react';
import { SettingsGroup } from './SettingsSurface';
import { EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import type { PluginLogs } from '../../lib/types';

// Log level → text colour for the Logs panel.
const LOG_LEVEL_CLASS: Record<'debug' | 'info' | 'warn' | 'error', string> = {
  debug: 'text-text-muted/70',
  info: 'text-text-muted',
  warn: 'text-warning',
  error: 'text-danger',
};

/** Logs panel: the tail of the plugin's log ring, newest last. */
export function PluginLogsPanel({ logs }: { logs?: PluginLogs }) {
  const { t, locale } = useTranslation();
  return (
    <SettingsGroup className="plugin-card" icon={ScrollText} title={t.pluginDetail.logs} description={t.pluginDetail.logsHint}>
      <div className="settings-group__panel flex flex-col gap-3">
        {!logs || logs.entries.length === 0 ? (
          <EmptyState title={t.pluginDetail.logsEmpty} icon={ScrollText} />
        ) : (
          <div className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed">
            {logs.entries.map((e, i) => (
              <div key={i} className="flex gap-2 py-0.5">
                <span className="shrink-0 text-text-muted">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                <span className={`shrink-0 uppercase ${LOG_LEVEL_CLASS[e.level]}`}>{e.level}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}
