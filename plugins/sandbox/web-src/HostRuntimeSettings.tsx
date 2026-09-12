import { Check, CircleDashed, Download, Server, TriangleAlert } from 'lucide-react';
import { jsonBody, localizedError, runtime } from './runtime';

interface HostRequirement {
  id: string;
  area: 'package' | 'systemd' | 'helper' | 'polkit' | 'firewall' | 'rootfs' | 'runtime';
  label: string;
  ok: boolean;
  detail?: string;
  published?: boolean;
  present?: boolean;
  sizeBytes?: number | null;
}
interface HostOperation {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  errorCode: string | null;
  steps: string[];
  stepIndex: number;
  stepTotal: number;
  stepLabel: string | null;
  percent: number | null;
}
interface HostReadiness {
  runtime: 'nspawn';
  ready: boolean;
  prepared: boolean;
  requirements: HostRequirement[];
  operation: HostOperation | null;
}

const AREA_ORDER: HostRequirement['area'][] = ['package', 'systemd', 'helper', 'polkit', 'firewall', 'rootfs', 'runtime'];

export function HostRuntimeSettings() {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const queryKey = ['plugin', 'sandbox', 'host-runtime'];
  const query = hooks.useQuery<HostReadiness>({
    queryKey,
    queryFn: () => api('/plugins/sandbox/api/runtime/host'),
    refetchInterval: (state: { state?: { data?: HostReadiness } }) => ['pending', 'running'].includes(state.state?.data?.operation?.status ?? '') ? 1200 : false,
  });
  const provision = hooks.useMutation<HostOperation, unknown, void>({
    mutationFn: () => api('/plugins/sandbox/api/runtime/host', jsonBody({ action: { kind: 'provision' }, requestId: `host-${crypto.randomUUID()}` })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey }); },
  });
  const start = () => { provision.mutate(undefined, { onError: (error: unknown) => toast(localizedError(error, s), 'error') }); };

  if (query.isError) return <C.ErrorState message={localizedError(query.error, s)} onRetry={() => query.refetch()} />;
  if (query.isLoading || !query.data) return <C.LoadingState variant="list" />;

  const report = query.data;
  const running = report.operation && ['pending', 'running'].includes(report.operation.status);
  const groups = AREA_ORDER.map((area) => ({ area, items: report.requirements.filter((item) => item.area === area) })).filter((group) => group.items.length);
  const operationLabel = report.operation?.stepLabel === 'host' ? s.hostStepHost
    : report.operation?.stepLabel === 'verify' ? s.hostStepVerify
    : report.operation?.stepLabel?.startsWith('rootfs:') ? `${s.hostStepRootfs}: ${report.operation.stepLabel.slice(7)}`
    : s.hostOperation;
  const statusLabel = report.prepared ? s.hostPrepared : report.ready ? s.hostReady : s.hostBlocked;
  const StatusIcon = report.prepared ? Check : report.ready ? CircleDashed : TriangleAlert;

  return <section className="flex flex-col gap-5 py-2">
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border ${report.ready ? 'border-success/30 bg-success/10 text-success' : 'border-warning/30 bg-warning/10 text-warning'}`}>
          <Server aria-hidden className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{s.hostRuntimeTitle}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.hostRuntimeHint}</p>
          <span className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-foreground" role="status">
            <StatusIcon aria-hidden className="h-3.5 w-3.5" />{statusLabel}
          </span>
        </div>
      </div>
      <C.Button variant="accent" icon={Download} disabled={provision.isPending || !!running || report.prepared} onClick={start}>
        {running ? s.hostProvisioning : report.prepared ? s.hostPrepared : s.hostProvision}
      </C.Button>
    </div>

    {report.operation ? <div className="rounded-md border border-border p-3" aria-label={s.hostOperation}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{operationLabel}</span>
        <span className="font-mono text-muted-foreground">{report.operation.percent === null ? s.hostWorking : `${report.operation.percent}%`}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${report.operation.status === 'failed' ? 'bg-destructive' : 'bg-accent'} transition-[width] duration-300`} style={{ width: `${report.operation.percent ?? 12}%` }} />
      </div>
      {report.operation.error ? <p role="alert" className="mt-2 text-xs text-destructive">{report.operation.error}</p> : null}
    </div> : null}

    <div className="flex flex-col gap-4">
      {groups.map(({ area, items }) => <C.SettingsGroup key={area} title={s[`hostArea_${area}`]} description={s[`hostArea_${area}Hint`]} density="compact">
        {items.map((item) => <C.SettingsRow key={item.id} label={item.label} description={item.detail}
          status={<C.Badge tone={item.ok ? 'success' : 'danger'}>{item.ok ? s.hostRequirementReady : s.hostRequirementMissing}</C.Badge>}
          control={item.area === 'rootfs' && item.sizeBytes ? <span className="font-mono text-xs text-muted-foreground">{Math.round(item.sizeBytes / 1024 / 1024)} MiB</span> : undefined}
        />)}
      </C.SettingsGroup>)}
    </div>
  </section>;
}
