'use client';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Braces, ChevronDown, ChevronRight, Copy, Database, Filter,
  ListFilter, MessageSquareText, Server, Wrench,
} from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Segmented } from '../../components/ui/Segmented';
import { useToast } from '../../components/ui/Toast';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states';
import { formatCost, formatDuration, formatTokens, localDateTime } from '../../lib/format';
import {
  useBrainDebugLegacy, useBrainDebugRaw, useBrainDebugRequest, useBrainDebugRequests,
  useBrainDebugSegment, useBrainDebugSessions,
} from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { useMobile } from '../../lib/useMobile';
import type {
  BrainDebugRequestItem, BrainDebugSegmentManifestItem, BrainDebugSegmentPayload, BrainDebugSessionItem,
} from '../../lib/types';

/** The segment legend's swatches. `tool` and `reasoning` need a hue no semantic token owns — calling
 *  them "info" or "warning" would state something about the segment that is not true — so they take the
 *  two categorical tones tokens.css declares for exactly this. */
const ROLE_CLASS: Record<string, string> = {
  system: 'bg-primary', user: 'bg-success', assistant: 'bg-warning', tool: 'bg-chart-4',
  reasoning: 'bg-chart-5', error: 'bg-destructive', options: 'bg-muted-foreground', response: 'bg-warning',
};

type Filters = {
  search: string; from: string; to: string; userId: string; surface: string;
  provider: string; model: string; status: string;
};

const EMPTY_FILTERS: Filters = { search: '', from: '', to: '', userId: '', surface: '', provider: '', model: '', status: '' };
const validUserId = (value: string): boolean => value === '' || /^[1-9]\d*$/.test(value);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

type SegmentLike = BrainDebugSegmentManifestItem | BrainDebugSegmentPayload;

function segmentPayload(segment: SegmentLike): unknown {
  return 'payload' in segment ? segment.payload : undefined;
}

function segmentRole(segment: SegmentLike): string {
  if (segment.role) return segment.role;
  if (segment.section === 'system') return 'system';
  if (segment.section === 'tool') return 'tool';
  if (segment.section === 'options') return 'options';
  if (segment.section === 'response') return 'response';
  const item = asRecord(segmentPayload(segment));
  const role = typeof item?.role === 'string' ? item.role : typeof item?.type === 'string' ? item.type : segment.kind;
  if (/reason/i.test(role)) return 'reasoning';
  if (/tool.*result|function.*result/i.test(role)) return 'tool';
  if (/error/i.test(role)) return 'error';
  return role;
}

function segmentLabel(segment: SegmentLike): string {
  if (segment.label) return segment.label;
  const item = asRecord(segmentPayload(segment));
  const name = typeof item?.name === 'string' ? item.name : typeof item?.type === 'string' ? item.type : null;
  return name ?? segment.key ?? segment.kind;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function PrettyPayload({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const { t } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'string') return <div className="whitespace-pre-wrap text-sm leading-6 text-foreground">{value}</div>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="font-mono text-sm text-foreground">{String(value)}</span>;
  if (Array.isArray(value)) return <div className="space-y-3">{value.map((item, index) => <PrettyPayload key={index} value={item} depth={depth + 1} />)}</div>;
  const item = asRecord(value);
  if (!item) return <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{pretty(value)}</pre>;

  const type = typeof item.type === 'string' ? item.type : '';
  const role = typeof item.role === 'string' ? item.role : '';
  const fn = asRecord(item.function);
  const name = String(item.name ?? fn?.name ?? (type || 'Item'));
  // `thinking` is Anthropic's field name for a reasoning block; without it the block falls through to the
  // generic key/value table and reads like raw JSON, which is exactly what the Pretty view exists to avoid.
  const text = item.text ?? item.output_text ?? item.input_text ?? item.thinking;
  if (typeof text === 'string') {
    const reasoning = /reason|thinking/i.test(type) || typeof item.thinking === 'string';
    return reasoning ? (
      <details className="rounded-md border border-border bg-muted/30">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted-foreground">{d.reasoning}</summary>
        <div className="border-t border-border p-3"><PrettyPayload value={text} depth={depth + 1} /></div>
      </details>
    ) : <PrettyPayload value={text} depth={depth + 1} />;
  }
  if (role && item.content !== undefined) {
    return (
      <article className="rounded-md border border-border bg-muted/20 p-3">
        <div className="mb-3 flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${ROLE_CLASS[role] ?? 'bg-muted-foreground'}`} /><strong className="text-xs uppercase tracking-wide text-muted-foreground">{role}</strong></div>
        <PrettyPayload value={item.content} depth={depth + 1} />
      </article>
    );
  }
  if (/^(tool_use|function_call|server_tool_use)$/i.test(type) || item.input !== undefined || item.arguments !== undefined || fn?.arguments !== undefined) {
    const args = item.input ?? item.arguments ?? fn?.arguments;
    return (
      <article className="rounded-md border border-primary/30 bg-primary/5 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-primary" /><strong className="text-sm text-foreground">{name}</strong><Badge tone="accent">{d.toolCall}</Badge></div>
        {args === undefined ? null : <pre className="max-h-80 overflow-auto rounded bg-background/60 p-3 text-xs text-muted-foreground">{pretty(args)}</pre>}
      </article>
    );
  }
  if (/tool_result|function_call_output|tool_search_tool_result/i.test(type) || item.output !== undefined) {
    return (
      <article className="rounded-md border border-success/30 bg-success/5 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-success" /><strong className="text-sm text-foreground">{name}</strong><Badge tone="success">{d.toolResult}</Badge></div>
        <PrettyPayload value={item.content ?? item.output} depth={depth + 1} />
      </article>
    );
  }
  if (/image|audio|video|file/i.test(type)) {
    return <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-3"><Badge>{type}</Badge><span className="text-xs text-muted-foreground">{d.mediaContent}</span></div>;
  }
  if (item.content !== undefined) return <PrettyPayload value={item.content} depth={depth + 1} />;
  if (item.input_schema !== undefined || fn?.parameters !== undefined || item.parameters !== undefined) {
    return (
      <article className="rounded-md border border-border bg-muted/20 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-primary" /><strong className="text-sm text-foreground">{name}</strong></div>
        {typeof item.description === 'string' ? <p className="mb-3 text-sm leading-6 text-muted-foreground">{item.description}</p> : null}
        <pre className="max-h-80 overflow-auto rounded bg-background/60 p-3 text-xs text-muted-foreground">{pretty(toolSchema(value))}</pre>
      </article>
    );
  }
  if (depth > 2) return <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{pretty(value)}</pre>;
  return (
    <dl className="divide-y divide-border rounded-md border border-border bg-muted/20">
      {Object.entries(item).map(([key, nested]) => (
        <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 p-3">
          <dt className="font-mono text-[11px] text-muted-foreground">{key}</dt>
          <dd className="min-w-0"><PrettyPayload value={nested} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
}

function toolName(payload: unknown): string {
  const item = asRecord(payload);
  const fn = asRecord(item?.function);
  return String(item?.name ?? fn?.name ?? item?.type ?? 'tool');
}

function toolSchema(payload: unknown): unknown {
  const item = asRecord(payload);
  const fn = asRecord(item?.function);
  return item?.input_schema ?? item?.parameters ?? fn?.parameters ?? item?.schema ?? payload;
}

function toolLoadingBadge(payload: unknown): 'immediate' | 'deferred' | 'server' {
  const item = asRecord(payload);
  const type = String(item?.type ?? '').toLowerCase();
  if (type && type !== 'function' && type !== 'custom') return 'server';
  if (item?.deferred === true || item?.defer_loading === true || item?.deferLoading === true) return 'deferred';
  return 'immediate';
}

function statusTone(status: string): 'success' | 'danger' | 'warning' | 'muted' {
  if (status === 'succeeded' || status === 'captured') return 'success';
  if (status === 'error') return 'danger';
  if (status === 'pending' || status === 'interrupted') return 'warning';
  return 'muted';
}

function Select({ value, onChange, label, children }: { value: string; onChange: (value: string) => void; label: string; children: ReactNode }) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-md border border-border bg-card px-2 text-xs text-foreground">
      {children}
    </select>
  );
}

function Kpi({ label, value, exact }: { label: string; value: string; exact?: boolean }) {
  return (
    <div className="min-w-[7rem] rounded-md border border-border bg-muted/50 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}{exact ? <span title="Exact provider aggregate">•</span> : null}</div>
      <div className="mt-1 truncate font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}

function RequestGraph({ request, segments, cachedEstimateLabel }: { request: BrainDebugRequestItem; segments: BrainDebugSegmentManifestItem[]; cachedEstimateLabel: string }) {
  const graph = segments.filter((segment) => segment.section !== 'response' && segment.section !== 'options');
  const prompt = graph.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
  const cached = Math.max(0, request.cacheReadTokens ?? 0);
  const cachedPercent = prompt > 0 ? Math.min(100, cached / prompt * 100) : 0;
  // No minimum width and nothing to scroll sideways. Every segment is sized as a percentage, so the bar
  // is legible at any width; the 36rem floor it used to sit behind was a hard 576px that overflowed the
  // dialog on every phone.
  return (
    <div aria-label="Prompt token segments">
      <div className="relative flex h-8 overflow-hidden rounded-md border border-border bg-background sm:h-12">
        {graph.map((segment) => {
          const role = segmentRole(segment);
          const width = prompt > 0 ? Math.max(2, segment.estimatedTokens / prompt * 100) : 100 / Math.max(1, graph.length);
          return <div key={`${segment.index}-${segment.digest}`} title={`${role}: ~${segment.estimatedTokens} tokens`} className={`${ROLE_CLASS[role] ?? 'bg-muted-foreground'} border-r border-background/40 opacity-80`} style={{ width: `${width}%` }} />;
        })}
        {cachedPercent > 0 ? <div className="pointer-events-none absolute inset-y-0 left-0 border-r-2 border-dashed border-foreground bg-foreground/10" style={{ width: `${cachedPercent}%` }} /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[10px] text-muted-foreground">
        <span>~{formatTokens(prompt)} prompt tokens</span>
        <span>{cachedEstimateLabel}: ~{Math.round(cachedPercent)}%</span>
      </div>
    </div>
  );
}

function SessionRail({ sessions, selectedId, onSelect, filters, setFilters, hasMore, loadingMore, loadMore }: {
  sessions: BrainDebugSessionItem[]; selectedId: string | null; onSelect: (id: string) => void;
  filters: Filters; setFilters: (next: Filters) => void; hasMore: boolean; loadingMore: boolean; loadMore: () => void;
}) {
  const { t, locale } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  const userIdErrorId = useId();
  const userIdIsValid = validUserId(filters.userId);
  const set = (key: keyof Filters, value: string) => setFilters({ ...filters, [key]: value });
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-background/40" data-testid="diagnostics-session-rail">
      <div className="space-y-2 border-b border-border p-3">
        <Input aria-label={d.searchSessions} placeholder={d.searchSessions} value={filters.search} onChange={(event) => set('search', event.target.value)} />
        <details className="text-xs text-muted-foreground">
          <summary className="flex cursor-pointer items-center gap-2 py-1"><Filter size={13} />{d.filters}</summary>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Input aria-label={d.from} type="date" value={filters.from} onChange={(event) => set('from', event.target.value)} />
            <Input aria-label={d.to} type="date" value={filters.to} onChange={(event) => set('to', event.target.value)} />
            <div className="min-w-0">
              <Input
                aria-label={d.userId}
                aria-invalid={!userIdIsValid}
                aria-describedby={!userIdIsValid ? userIdErrorId : undefined}
                inputMode="numeric"
                placeholder={d.userId}
                value={filters.userId}
                onChange={(event) => set('userId', event.target.value)}
              />
              {!userIdIsValid ? <p id={userIdErrorId} role="alert" className="pt-1 text-[10px] leading-tight text-destructive">{d.userIdInvalid}</p> : null}
            </div>
            <Select label={d.surface} value={filters.surface} onChange={(value) => set('surface', value)}><option value="">{d.all}</option><option value="conversation">{d.conversation}</option><option value="channel">{d.channel}</option><option value="subagent">{d.subagent}</option></Select>
            <Input aria-label={d.provider} placeholder={d.provider} value={filters.provider} onChange={(event) => set('provider', event.target.value)} />
            <Input aria-label={d.model} placeholder={d.model} value={filters.model} onChange={(event) => set('model', event.target.value)} />
            <Select label={d.status} value={filters.status} onChange={(value) => set('status', value)}><option value="">{d.all}</option><option value="pending">{d.pending}</option><option value="succeeded">{d.succeeded}</option><option value="captured">{d.captured}</option><option value="legacy">{d.legacy}</option><option value="error">{d.error}</option><option value="interrupted">{d.interrupted}</option></Select>
          </div>
        </details>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((session) => (
          <button key={session.id} type="button" aria-current={selectedId === session.id} onClick={() => onSelect(session.id)} className={`w-full border-b border-border px-3 py-3 text-left hover:bg-accent ${selectedId === session.id ? 'bg-accent' : ''}`}>
            <div className="flex items-start justify-between gap-2"><strong className="line-clamp-2 text-xs text-foreground">{session.title || session.id}</strong><Badge tone={statusTone(session.latestRequestStatus ?? (session.requestCount ? 'captured' : 'legacy'))}>{session.requestCount ? session.requestCount : d.legacy}</Badge></div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">{session.userName || session.username} · {session.surface}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{session.provider}/{session.model}</div>
            <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground"><span>{formatTokens(session.totalTokens)} tok · {session.costedRequestCount ? formatCost(session.costUsd) : '—'}</span><span>{localDateTime(session.updatedAt, locale, false)}</span></div>
          </button>
        ))}
        {hasMore ? <div className="p-3"><Button className="w-full" variant="ghost" disabled={loadingMore} onClick={loadMore}>{d.loadMore}</Button></div> : null}
      </div>
    </div>
  );
}

function RequestSelector({ requests, selectedId, onSelect, hasMore, loadMore }: { requests: BrainDebugRequestItem[]; selectedId: string | null; onSelect: (id: string) => void; hasMore: boolean; loadMore: () => void }) {
  const { t } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2" aria-label={d.requests}>
      {requests.map((request) => (
        <button key={request.requestId} type="button" aria-pressed={selectedId === request.requestId} onClick={() => onSelect(request.requestId)} className={`shrink-0 rounded-md border px-3 py-2 text-left ${selectedId === request.requestId ? 'border-primary bg-primary/10' : 'border-border bg-muted/40'}`}>
          <div className="flex items-center gap-2"><span className="font-mono text-xs text-foreground">#{request.seq}</span><Badge>{request.kind}</Badge><Badge tone={statusTone(request.status)}>{request.status}</Badge>{request.retryOf ? <Badge tone="warning">{d.retry}</Badge> : null}</div>
          <div className="mt-1 max-w-44 truncate text-[10px] text-muted-foreground">{request.model}</div>
        </button>
      ))}
      {hasMore ? <Button variant="ghost" onClick={loadMore}>{d.loadMore}</Button> : null}
    </div>
  );
}

function ToolEntry({ sessionId, requestId, tool }: { sessionId: string | null; requestId: string | null; tool: BrainDebugSegmentManifestItem }) {
  const { t } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  const [open, setOpen] = useState(false);
  const payload = useBrainDebugSegment(sessionId, requestId, open ? tool.index : null);
  const badge = payload.data ? toolLoadingBadge(payload.data.payload) : null;
  return (
    <details className="mb-2 rounded-md border border-border bg-card" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer list-none p-3">
        <div className="flex items-center gap-2"><Wrench size={13} className="text-primary" /><strong className="min-w-0 flex-1 truncate text-xs text-foreground">{payload.data ? toolName(payload.data.payload) : segmentLabel(tool)}</strong>{badge ? <Badge tone={badge === 'server' ? 'accent' : badge === 'deferred' ? 'warning' : 'muted'}>{d[badge]}</Badge> : null}</div>
        {tool.preview && tool.preview !== segmentLabel(tool) ? <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{tool.preview}</div> : null}
      </summary>
      {open ? <div className="border-t border-border">{payload.isLoading ? <LoadingState /> : payload.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => payload.refetch()} /> : <pre className="max-h-80 overflow-auto p-3 text-[11px] text-muted-foreground">{pretty(toolSchema(payload.data?.payload))}</pre>}</div> : null}
    </details>
  );
}

function ToolsPanel({ sessionId, requestId, tools, query, setQuery }: { sessionId: string | null; requestId: string | null; tools: BrainDebugSegmentManifestItem[]; query: string; setQuery: (value: string) => void }) {
  const { t } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  const filtered = tools.filter((tool) => `${tool.key ?? ''} ${tool.kind} ${tool.digest}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col bg-background/40" data-testid="diagnostics-tools-panel">
      <div className="border-b border-border p-3"><Input aria-label={d.searchTools} placeholder={d.searchTools} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? <EmptyState title={d.noTools} icon={Wrench} /> : filtered.map((tool) => <ToolEntry key={`${tool.index}-${tool.digest}`} sessionId={sessionId} requestId={requestId} tool={tool} />)}
      </div>
    </div>
  );
}

export function ConversationDiagnosticsModal({ captureEnabled, onEnableCapture, onClose }: { captureEnabled: boolean; onEnableCapture: () => Promise<void> | void; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const d = t.settings.conversationDiagnostics;
  const mobile = useMobile();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const deferredFilters = useDeferredValue(filters);
  const queryFilters = useMemo(() => ({
    search: deferredFilters.search || undefined, from: deferredFilters.from || undefined, to: deferredFilters.to || undefined,
    userId: validUserId(deferredFilters.userId) && deferredFilters.userId ? Number(deferredFilters.userId) : undefined, surface: deferredFilters.surface || undefined,
    provider: deferredFilters.provider || undefined, model: deferredFilters.model || undefined, status: deferredFilters.status || undefined,
  }), [deferredFilters]);
  const sessionsQuery = useBrainDebugSessions(queryFilters);
  const sessions = useMemo(() => sessionsQuery.data?.pages.flatMap((page) => page.items) ?? [], [sessionsQuery.data]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const selectedSession = sessions.find((session) => session.id === sessionId) ?? null;
  const requestsQuery = useBrainDebugRequests(sessionId);
  const requests = useMemo(() => requestsQuery.data?.pages.flatMap((page) => page.items) ?? [], [requestsQuery.data]);
  const [requestId, setRequestId] = useState<string | null>(null);
  const detail = useBrainDebugRequest(sessionId, requestId);
  const segments = detail.data?.segments ?? [];
  const [rawOpen, setRawOpen] = useState(false);
  const raw = useBrainDebugRaw(sessionId, requestId, rawOpen);
  const legacy = useBrainDebugLegacy(sessionId, !!selectedSession && selectedSession.requestCount === 0);
  const [messageQuery, setMessageQuery] = useState('');
  const [role, setRole] = useState('all');
  const [selectedSegment, setSelectedSegment] = useState<BrainDebugSegmentManifestItem | null>(null);
  const selectedPayload = useBrainDebugSegment(sessionId, requestId, selectedSegment?.index ?? null);
  const [visibleMessages, setVisibleMessages] = useState(100);
  const [inspectorRaw, setInspectorRaw] = useState(false);
  const [mobileContent, setMobileContent] = useState<'messages' | 'inspector'>('messages');
  const [toolQuery, setToolQuery] = useState('');
  const [mobileView, setMobileView] = useState<'content' | 'sessions' | 'tools'>('content');
  const [captureConfirmOpen, setCaptureConfirmOpen] = useState(false);
  const [capturePending, setCapturePending] = useState(false);
  const capturePendingRef = useRef(false);
  const captureOpRef = useRef(0);
  const contentRegionRef = useRef<HTMLElement>(null);
  const focusContentAfterSessionSelect = useRef(false);

  useEffect(() => { setSessionId(null); setRequestId(null); }, [queryFilters]);
  useEffect(() => {
    if (!sessionId && sessions[0]) setSessionId(sessions[0].id);
  }, [sessionId, sessions]);
  useEffect(() => {
    setRequestId((current) => current && requests.some((request) => request.requestId === current) ? current : requests[0]?.requestId ?? null);
  }, [sessionId, requests]);
  useEffect(() => {
    setRawOpen(false); setSelectedSegment(null); setInspectorRaw(false); setMobileContent('messages'); setToolQuery(''); setVisibleMessages(100);
  }, [requestId]);
  useEffect(() => {
    if (!mobile || mobileView !== 'content' || !focusContentAfterSessionSelect.current) return;
    focusContentAfterSessionSelect.current = false;
    contentRegionRef.current?.focus({ preventScroll: true });
  }, [mobile, mobileView, sessionId]);

  const messages = segments.filter((segment) => segment.section !== 'tool' && segment.section !== 'options');
  const filteredMessages = messages.filter((segment) => {
    const itemRole = segmentRole(segment);
    const haystack = `${segment.role ?? ''} ${segment.label ?? ''} ${segment.preview ?? ''} ${segment.key ?? ''} ${segment.kind} ${segment.digest}`.toLowerCase();
    return (role === 'all' || role === itemRole) && haystack.includes(messageQuery.toLowerCase());
  });
  const visibleMessageItems = filteredMessages.slice(0, visibleMessages);
  const roles = [...new Set(messages.map(segmentRole))];
  const tools = segments.filter((segment) => segment.section === 'tool');
  const selectedRequest = detail.data;
  const legacyItems = legacy.data?.pages.flatMap((page) => page.items) ?? [];

  const copy = (value: unknown) => { void navigator.clipboard?.writeText(pretty(value)); };
  const selectSession = (id: string) => {
    setSessionId(id);
    if (!mobile) return;
    focusContentAfterSessionSelect.current = true;
    setMobileView('content');
  };
  const openCaptureConfirm = () => {
    captureOpRef.current += 1;
    capturePendingRef.current = false;
    setCapturePending(false);
    setCaptureConfirmOpen(true);
  };
  const closeCaptureConfirm = () => {
    captureOpRef.current += 1;
    capturePendingRef.current = false;
    setCapturePending(false);
    setCaptureConfirmOpen(false);
  };
  const enableCapture = async (): Promise<void> => {
    if (!captureConfirmOpen || capturePendingRef.current) return;
    const operation = ++captureOpRef.current;
    capturePendingRef.current = true;
    setCapturePending(true);
    try {
      await onEnableCapture();
      if (operation !== captureOpRef.current) return;
      capturePendingRef.current = false;
      setCapturePending(false);
      setCaptureConfirmOpen(false);
    } catch {
      if (operation !== captureOpRef.current) return;
      capturePendingRef.current = false;
      setCapturePending(false);
      toast(d.captureEnableError, 'error');
    }
  };
  const sessionRail = <SessionRail sessions={sessions} selectedId={sessionId} onSelect={selectSession} filters={filters} setFilters={setFilters} hasMore={sessionsQuery.hasNextPage} loadingMore={sessionsQuery.isFetchingNextPage} loadMore={() => void sessionsQuery.fetchNextPage()} />;
  const toolsPanel = <ToolsPanel sessionId={sessionId} requestId={requestId} tools={tools} query={toolQuery} setQuery={setToolQuery} />;

  return (
    // Fullscreen, not the drawer the first overlay in a section otherwise gets: this is a three-column
    // workspace (session list, transcript, inspector) over raw provider payloads, and a drawer gives it
    // neither the width for the columns nor the height to read a request without scrolling the rail away.
    <Modal
      title={d.title}
      description={selectedSession ? `${selectedSession.title || selectedSession.id} · ${selectedSession.userName || selectedSession.username}` : d.description}
      icon={Database}
      presentation="fullscreen"
      onClose={onClose}
    >
      {!captureEnabled ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle size={14} />{d.captureDisabled}
          <Button className="ml-auto" variant="ghost" onClick={openCaptureConfirm}>{d.enableCapture}</Button>
        </div>
      ) : null}
      {mobile ? (
        <div className="border-b border-border px-3 py-2">
          <Segmented
            aria-label={d.mobileView}
            value={mobileView}
            onChange={(value) => setMobileView(value as 'content' | 'sessions' | 'tools')}
            options={[{ value: 'content', label: d.content }, { value: 'sessions', label: d.sessions }, { value: 'tools', label: d.tools }]}
            nowrap
          />
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)_20rem]">
        <aside className={`${mobileView === 'sessions' ? 'block' : 'hidden'} min-h-0 md:block`}>{sessionRail}</aside>
        <main ref={contentRegionRef} tabIndex={-1} aria-label={d.contentView} className={`${mobileView === 'content' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col outline-none md:flex`}>
          {sessionsQuery.isLoading ? <LoadingState /> : sessionsQuery.isError ? <ErrorState message={d.loadError} onRetry={() => sessionsQuery.refetch()} /> : sessions.length === 0 ? <EmptyState title={d.noSessions} icon={MessageSquareText} /> : selectedSession?.requestCount === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning">{d.legacyWarning}</div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {legacy.isLoading ? <LoadingState /> : legacy.isError ? <ErrorState message={d.loadError} onRetry={() => legacy.refetch()} /> : legacyItems.length === 0 ? <EmptyState title={d.noLegacyData} icon={MessageSquareText} /> : legacyItems.map((item) => (
                  <article key={item.id} className="mb-3 rounded-md border border-border bg-muted/30 p-3"><div className="mb-2 flex items-center justify-between"><Badge>{item.role}</Badge><span className="text-[10px] text-muted-foreground">{localDateTime(item.createdAt, locale)}</span></div><pre className="whitespace-pre-wrap text-xs text-muted-foreground">{pretty(item.content)}</pre></article>
                ))}
                {legacy.hasNextPage ? <Button onClick={() => void legacy.fetchNextPage()}>{d.loadMore}</Button> : null}
              </div>
            </div>
          ) : requestsQuery.isLoading ? <LoadingState /> : requestsQuery.isError ? <ErrorState message={d.loadError} onRetry={() => requestsQuery.refetch()} /> : requests.length === 0 ? <EmptyState title={d.noRequests} icon={Server} /> : (
            <>
              <RequestSelector requests={requests} selectedId={requestId} onSelect={setRequestId} hasMore={requestsQuery.hasNextPage} loadMore={() => void requestsQuery.fetchNextPage()} />
              <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                {detail.isLoading ? <LoadingState /> : detail.isError ? <ErrorState message={d.loadError} onRetry={() => void detail.refetch()} /> : selectedRequest ? (
                  <div className="space-y-4">
                    <section className="rounded-lg border border-border bg-muted/30 p-3">
                      <RequestGraph request={selectedRequest} segments={segments} cachedEstimateLabel={d.cachedPrefixEstimate} />
                      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                        <Kpi label={d.prompt} value={`~${formatTokens(segments.filter((s) => s.section !== 'response' && s.section !== 'options').reduce((sum, s) => sum + s.estimatedTokens, 0))}`} />
                        <Kpi label={d.cacheRead} value={selectedRequest.cacheReadTokens == null ? '—' : formatTokens(selectedRequest.cacheReadTokens)} exact />
                        <Kpi label={d.cacheWrite} value={selectedRequest.cacheWriteTokens == null ? '—' : formatTokens(selectedRequest.cacheWriteTokens)} exact />
                        <Kpi label={d.input} value={selectedRequest.inputTokens == null ? '—' : formatTokens(selectedRequest.inputTokens)} exact />
                        <Kpi label={d.output} value={selectedRequest.outputTokens == null ? '—' : formatTokens(selectedRequest.outputTokens)} exact />
                        <Kpi label={d.reasoning} value={selectedRequest.reasoningTokens == null ? '—' : formatTokens(selectedRequest.reasoningTokens)} exact />
                        <Kpi label={d.cost} value={selectedRequest.costUsd == null ? d.notAvailable : formatCost(selectedRequest.costUsd)} exact />
                        <Kpi label={d.duration} value={selectedRequest.durationMs == null ? '—' : formatDuration(selectedRequest.durationMs)} exact />
                        <Kpi label={d.model} value={selectedRequest.model} /><Kpi label={d.provider} value={selectedRequest.wireProvider} />
                      </div>
                      {selectedRequest.errorMessage ? <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">{selectedRequest.errorCode ? `${selectedRequest.errorCode}: ` : ''}{selectedRequest.errorMessage}</div> : null}
                    </section>

                    <div className="flex rounded-md border border-border bg-muted/30 p-1 xl:hidden" role="tablist" aria-label={d.contentView}>
                      <button type="button" role="tab" aria-selected={mobileContent === 'messages'} onClick={() => setMobileContent('messages')} className={`flex-1 rounded px-3 py-2 text-xs font-semibold ${mobileContent === 'messages' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>{d.messages}</button>
                      <button type="button" role="tab" aria-selected={mobileContent === 'inspector'} disabled={!selectedSegment} onClick={() => setMobileContent('inspector')} className={`flex-1 rounded px-3 py-2 text-xs font-semibold disabled:opacity-40 ${mobileContent === 'inspector' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'}`}>{d.inspector}</button>
                    </div>
                    <section className="grid min-h-[24rem] grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
                      <div className={`${mobileContent === 'inspector' ? 'hidden xl:flex' : 'flex'} min-h-0 flex-col rounded-lg border border-border`}>
                        <div className="flex flex-wrap gap-2 border-b border-border p-3">
                          <Input className="min-w-48 flex-1" aria-label={d.searchMessages} placeholder={d.searchMessages} value={messageQuery} onChange={(event) => setMessageQuery(event.target.value)} />
                          <Select label={d.role} value={role} onChange={setRole}><option value="all">{d.allRoles}</option>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</Select>
                        </div>
                        <div className="max-h-[32rem] min-h-0 flex-1 overflow-y-auto">
                          {visibleMessageItems.map((segment) => {
                            const itemRole = segmentRole(segment);
                            return <button key={`${segment.index}-${segment.digest}`} type="button" aria-pressed={selectedSegment?.index === segment.index} onClick={() => { setSelectedSegment(segment); setMobileContent('inspector'); }} className={`flex w-full items-start gap-3 border-b border-border p-3 text-left hover:bg-accent ${selectedSegment?.index === segment.index ? 'bg-accent' : ''}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${ROLE_CLASS[itemRole] ?? 'bg-muted-foreground'}`} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="text-xs text-foreground">{itemRole}</strong><Badge>{segmentLabel(segment)}</Badge><span className="ml-auto font-mono text-[10px] text-muted-foreground">~{segment.estimatedTokens}</span></span><span className={`mt-1 line-clamp-2 text-xs ${segment.preview ? 'text-muted-foreground' : 'font-mono text-[10px] text-subtle-foreground'}`}>{segment.preview ?? segment.digest}</span></span></button>;
                          })}
                          {visibleMessages < filteredMessages.length ? <div className="p-3"><Button onClick={() => setVisibleMessages((value) => value + 100)}>{d.loadMore}</Button></div> : null}
                        </div>
                      </div>
                      <div data-testid="diagnostics-inspector" className={`${mobileContent === 'messages' ? 'hidden xl:flex' : 'flex'} min-h-0 flex-col rounded-lg border border-border`}>
                        {/* The label is the mobile tab's job; repeating it inside the panel just eats a row. */}
                        <div className="flex items-center gap-2 border-b border-border p-3"><Braces size={14} className="hidden text-primary xl:block" /><strong className="hidden text-xs text-foreground xl:inline">{d.inspector}</strong><div className="ml-auto flex items-center gap-1"><div className="flex rounded-md border border-border bg-background p-0.5" role="tablist" aria-label={d.displayMode}><button type="button" role="tab" aria-selected={!inspectorRaw} onClick={() => setInspectorRaw(false)} className={`rounded px-2.5 py-1 text-xs font-semibold ${!inspectorRaw ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}>{d.pretty}</button><button type="button" role="tab" aria-selected={inspectorRaw} onClick={() => setInspectorRaw(true)} className={`rounded px-2.5 py-1 text-xs font-semibold ${inspectorRaw ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}>{d.json}</button></div>{selectedPayload.data ? <Button variant="ghost" icon={Copy} aria-label={d.copy} onClick={() => copy(selectedPayload.data.payload)}>{d.copy}</Button> : null}</div></div>
                        <div className="max-h-[32rem] min-h-0 flex-1 overflow-auto p-3">{selectedSegment ? selectedPayload.isLoading ? <LoadingState /> : selectedPayload.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => selectedPayload.refetch()} /> : inspectorRaw ? <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{pretty(selectedPayload.data?.payload)}</pre> : <PrettyPayload value={selectedPayload.data?.payload} /> : <EmptyState title={d.pickMessage} icon={ListFilter} />}</div>
                      </div>
                    </section>

                    <section className="rounded-lg border border-border">
                      <button type="button" aria-expanded={rawOpen} onClick={() => setRawOpen((value) => !value)} className="flex w-full items-center gap-2 p-3 text-left text-xs font-semibold text-foreground">{rawOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Braces size={14} className="text-primary" />{d.rawRequest}<span className="ml-auto font-mono text-[10px] text-muted-foreground">{selectedRequest.segmentBytes} B</span></button>
                      {rawOpen ? <div className="border-t border-border p-3">{raw.isLoading ? <LoadingState /> : raw.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => raw.refetch()} /> : <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{pretty(raw.data?.payload)}</pre>}</div> : null}
                    </section>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </main>
        <aside className={`${mobileView === 'tools' ? 'block' : 'hidden'} min-h-0 border-l border-border md:block`}>{toolsPanel}</aside>
      </div>
      <ConfirmDialog
        open={captureConfirmOpen}
        title={d.captureConfirmTitle}
        description={d.captureConfirmDescription}
        confirmLabel={d.enableCapture}
        confirmVariant="accent"
        confirmDisabled={capturePending}
        onConfirm={enableCapture}
        onClose={closeCaptureConfirm}
      />
    </Modal>
  );
}
