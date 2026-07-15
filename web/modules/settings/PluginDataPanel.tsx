'use client';
import { useState, type ReactNode } from 'react';
import { Trash2, HardDrive } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { SettingsGroup } from './SettingsSurface';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useClearPluginData } from '../../lib/mutations';
import type { PluginDetail } from '../../lib/types';

/** Human-readable byte size for the Data section (KB/MB steps, 1 decimal above 10 units). */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** A label → value pair for the read-only detail grids (Overview, Data). */
function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <span className="min-w-0 text-sm text-text">{children}</span>
    </div>
  );
}

/** Data section body: the plugin's on-disk footprint plus a destructive "clear" behind a confirm. */
function DataSection({ name, summary }: { name: string; summary: { path: string; exists: boolean; files: number; bytes: number } }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const clear = useClearPluginData();
  const [confirm, setConfirm] = useState(false);
  if (!summary.exists || summary.files === 0) return <EmptyState title={t.pluginDetail.dataEmpty} icon={HardDrive} />;
  const doClear = () => {
    setConfirm(false);
    clear.mutate(name, {
      onSuccess: () => toast(t.pluginDetail.dataCleared),
      onError: () => toast(t.pluginDetail.dataClearError, 'error'),
    });
  };
  return (
    <div className="@container flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 @sm:grid-cols-3">
        <Meta label={t.pluginDetail.dataSize}>{formatBytes(summary.bytes)}</Meta>
        <Meta label={t.pluginDetail.dataFiles.replace('{n}', String(summary.files))}><span className="font-mono">{summary.files}</span></Meta>
        <div className="min-w-0 @sm:col-span-3">
          <Meta label={t.pluginDetail.dataPath}><span className="block break-all font-mono text-xs text-text-muted">{summary.path}</span></Meta>
        </div>
      </div>
      <Button variant="danger" icon={Trash2} className="self-start" onClick={() => setConfirm(true)} disabled={clear.isPending}>{t.pluginDetail.dataClear}</Button>
      <ConfirmDialog
        open={confirm}
        title={t.pluginDetail.dataClear}
        description={t.pluginDetail.dataClearConfirm}
        confirmLabel={t.pluginDetail.dataClear}
        onConfirm={doClear}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

/** Data panel: on-disk footprint + destructive clear, as a settings-group card. */
export function PluginDataPanel({ name, summary }: { name: string; summary: PluginDetail['data'] }) {
  const { t } = useTranslation();
  return (
    <SettingsGroup className="plugin-card" icon={HardDrive} title={t.pluginDetail.data}>
      <div className="settings-group__panel"><DataSection name={name} summary={summary} /></div>
    </SettingsGroup>
  );
}
