'use client';
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Braces, ChevronDown, ChevronRight, Copy, Database, Filter,
  ListFilter, Menu, MessageSquareText, PanelRightOpen, Server, Wrench,
} from 'lucide-react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
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

const ROLE_CLASS: Record<string, string> = {
  system: 'bg-accent', user: 'bg-success', assistant: 'bg-warning', tool: 'bg-[#a78bfa]',
  reasoning: 'bg-[#f472b6]', error: 'bg-danger', options: 'bg-text-muted', response: 'bg-warning',
};

type Filters = {
  search: string; from: string; to: string; userId: string; surface: string;
  provider: string; model: string; status: string;
};

const EMPTY_FILTERS: Filters = { search: '', from: '', to: '', userId: '', surface: '', provider: '', model: '', status: '' };

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
  if (value === null || value === undefined) return <span className="text-text-muted">—</span>;
  if (typeof value === 'string') return <div className="whitespace-pre-wrap text-sm leading-6 text-text">{value}</div>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="font-mono text-sm text-text">{String(value)}</span>;
  if (Array.isArray(value)) return <div className="space-y-3">{value.map((item, index) => <PrettyPayload key={index} value={item} depth={depth + 1} />)}</div>;
  const item = asRecord(value);
  if (!item) return <pre className="whitespace-pre-wrap text-xs text-text-muted">{pretty(value)}</pre>;

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
      <details className="rounded-md border border-border bg-elevated/30">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-text-muted">{d.reasoning}</summary>
        <div className="border-t border-border p-3"><PrettyPayload value={text} depth={depth + 1} /></div>
      </details>
    ) : <PrettyPayload value={text} depth={depth + 1} />;
  }
  if (role && item.content !== undefined) {
    return (
      <article className="rounded-md border border-border bg-elevated/20 p-3">
        <div className="mb-3 flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${ROLE_CLASS[role] ?? 'bg-text-muted'}`} /><strong className="text-xs uppercase tracking-wide text-text-muted">{role}</strong></div>
        <PrettyPayload value={item.content} depth={depth + 1} />
      </article>
    );
  }
  if (/^(tool_use|function_call|server_tool_use)$/i.test(type) || item.input !== undefined || item.arguments !== undefined || fn?.arguments !== undefined) {
    const args = item.input ?? item.arguments ?? fn?.arguments;
    return (
      <article className="rounded-md border border-accent/30 bg-accent/5 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-accent" /><strong className="text-sm text-text">{name}</strong><Badge tone="accent">{d.toolCall}</Badge></div>
        {args === undefined ? null : <pre className="max-h-80 overflow-auto rounded bg-bg/60 p-3 text-xs text-text-muted">{pretty(args)}</pre>}
      </article>
    );
  }
  if (/tool_result|function_call_output|tool_search_tool_result/i.test(type) || item.output !== undefined) {
    return (
      <article className="rounded-md border border-success/30 bg-success/5 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-success" /><strong className="text-sm text-text">{name}</strong><Badge tone="success">{d.toolResult}</Badge></div>
        <PrettyPayload value={item.content ?? item.output} depth={depth + 1} />
      </article>
    );
  }
  if (/image|audio|video|file/i.test(type)) {
    return <div className="flex items-center gap-2 rounded-md border border-border bg-elevated/30 p-3"><Badge>{type}</Badge><span className="text-xs text-text-muted">{d.mediaContent}</span></div>;
  }
  if (item.content !== undefined) return <PrettyPayload value={item.content} depth={depth + 1} />;
  if (item.input_schema !== undefined || fn?.parameters !== undefined || item.parameters !== undefined) {
    return (
      <article className="rounded-md border border-border bg-elevated/20 p-3">
        <div className="mb-2 flex items-center gap-2"><Wrench size={14} className="text-accent" /><strong className="text-sm text-text">{name}</strong></div>
        {typeof item.description === 'string' ? <p className="mb-3 text-sm leading-6 text-text-muted">{item.description}</p> : null}
        <pre className="max-h-80 overflow-auto rounded bg-bg/60 p-3 text-xs text-text-muted">{pretty(toolSchema(value))}</pre>
      </article>
    );
  }
  if (depth > 2) return <pre className="whitespace-pre-wrap text-xs text-text-muted">{pretty(value)}</pre>;
  return (
    <dl className="divide-y divide-border rounded-md border border-border bg-elevated/20">
      {Object.entries(item).map(([key, nested]) => (
        <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 p-3">
          <dt className="font-mono text-[11px] text-text-muted">{key}</dt>
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
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-md border border-border bg-surface px-2 text-xs text-text">
      {children}
    </select>
  );
}

function Kpi({ label, value, exact }: { label: string; value: string; exact?: boolean }) {
  return (
    <div className="min-w-[7rem] rounded-md border border-border bg-elevated/50 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}{exact ? <span title="Exact provider aggregate">•</span> : null}</div>
      <div className="mt-1 truncate font-mono text-sm text-text">{value}</div>
    </div>
  );
}

function RequestGraph({ request, segments, cachedEstimateLabel }: { request: BrainDebugRequestItem; segments: BrainDebugSegmentManifestItem[]; cachedEstimateLabel: string }) {
  const graph = segments.filter((segment) => segment.section !== 'response' && segment.section !== 'options');
  const prompt = graph.reduce((sum, segment) => sum + segment.estimatedTokens, 0);
  const cached = Math.max(0, request.cacheReadTokens ?? 0);
  const cachedPercent = prompt > 0 ? Math.min(100, cached / prompt * 100) : 0;
  return (
    <div className="overflow-x-auto" aria-label="Prompt token segments">
      <div className="min-w-[36rem]">
        <div className="relative flex h-8 overflow-hidden rounded-md border border-border bg-bg sm:h-12">
          {graph.map((segment) => {
            const role = segmentRole(segment);
            const width = prompt > 0 ? Math.max(2, segment.estimatedTokens / prompt * 100) : 100 / Math.max(1, graph.length);
            return <div key={`${segment.index}-${segment.digest}`} title={`${role}: ~${segment.estimatedTokens} tokens`} className={`${ROLE_CLASS[role] ?? 'bg-text-muted'} border-r border-bg/40 opacity-80`} style={{ width: `${width}%` }} />;
          })}
          {cachedPercent > 0 ? <div className="pointer-events-none absolute inset-y-0 left-0 border-r-2 border-dashed border-text bg-text/10" style={{ width: `${cachedPercent}%` }} /> : null}
        </div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-text-muted">
          <span>~{formatTokens(prompt)} prompt tokens</span>
          <span>{cachedEstimateLabel}: ~{Math.round(cachedPercent)}%</span>
        </div>
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
  const set = (key: keyof Filters, value: string) => setFilters({ ...filters, [key]: value });
  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-bg/40" data-testid="diagnostics-session-rail">
      <div className="space-y-2 border-b border-border p-3">
        <Input aria-label={d.searchSessions} placeholder={d.searchSessions} value={filters.search} onChange={(event) => set('search', event.target.value)} />
        <details className="text-xs text-text-muted">
          <summary className="flex cursor-pointer items-center gap-2 py-1"><Filter size={13} />{d.filters}</summary>
          <div className="grid grid-cols-2 gap-2 pt-2">
            <Input aria-label={d.from} type="date" value={filters.from} onChange={(event) => set('from', event.target.value)} />
            <Input aria-label={d.to} type="date" value={filters.to} onChange={(event) => set('to', event.target.value)} />
            <Input aria-label={d.userId} inputMode="numeric" placeholder={d.userId} value={filters.userId} onChange={(event) => set('userId', event.target.value)} />
            <Select label={d.surface} value={filters.surface} onChange={(value) => set('surface', value)}><option value="">{d.all}</option><option value="conversation">{d.conversation}</option><option value="channel">{d.channel}</option><option value="task">{d.task}</option><option value="subagent">{d.subagent}</option></Select>
            <Input aria-label={d.provider} placeholder={d.provider} value={filters.provider} onChange={(event) => set('provider', event.target.value)} />
            <Input aria-label={d.model} placeholder={d.model} value={filters.model} onChange={(event) => set('model', event.target.value)} />
            <Select label={d.status} value={filters.status} onChange={(value) => set('status', value)}><option value="">{d.all}</option><option value="captured">{d.captured}</option><option value="legacy">{d.legacy}</option><option value="error">{d.error}</option><option value="interrupted">{d.interrupted}</option></Select>
          </div>
        </details>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((session) => (
          <button key={session.id} type="button" aria-current={selectedId === session.id} onClick={() => onSelect(session.id)} className={`w-full border-b border-border px-3 py-3 text-left hover:bg-elevated ${selectedId === session.id ? 'bg-elevated' : ''}`}>
            <div className="flex items-start justify-between gap-2"><strong className="line-clamp-2 text-xs text-text">{session.title || session.id}</strong><Badge tone={statusTone(session.latestRequestStatus ?? (session.requestCount ? 'captured' : 'legacy'))}>{session.requestCount ? session.requestCount : d.legacy}</Badge></div>
            <div className="mt-1 truncate text-[11px] text-text-muted">{session.userName || session.username} · {session.surface}</div>
            <div className="mt-1 truncate font-mono text-[10px] text-text-muted">{session.provider}/{session.model}</div>
            <div className="mt-2 flex justify-between font-mono text-[10px] text-text-muted"><span>{formatTokens(session.totalTokens)} tok · {session.costedRequestCount ? formatCost(session.costUsd) : '—'}</span><span>{localDateTime(session.updatedAt, locale, false)}</span></div>
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
        <button key={request.requestId} type="button" aria-pressed={selectedId === request.requestId} onClick={() => onSelect(request.requestId)} className={`shrink-0 rounded-md border px-3 py-2 text-left ${selectedId === request.requestId ? 'border-accent bg-accent/10' : 'border-border bg-elevated/40'}`}>
          <div className="flex items-center gap-2"><span className="font-mono text-xs text-text">#{request.seq}</span><Badge>{request.kind}</Badge><Badge tone={statusTone(request.status)}>{request.status}</Badge>{request.retryOf ? <Badge tone="warning">{d.retry}</Badge> : null}</div>
          <div className="mt-1 max-w-44 truncate text-[10px] text-text-muted">{request.model}</div>
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
    <details className="mb-2 rounded-md border border-border bg-surface" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer list-none p-3">
        <div className="flex items-center gap-2"><Wrench size={13} className="text-accent" /><strong className="min-w-0 flex-1 truncate text-xs text-text">{payload.data ? toolName(payload.data.payload) : segmentLabel(tool)}</strong>{badge ? <Badge tone={badge === 'server' ? 'accent' : badge === 'deferred' ? 'warning' : 'muted'}>{d[badge]}</Badge> : null}</div>
        {tool.preview && tool.preview !== segmentLabel(tool) ? <div className="mt-1 line-clamp-2 text-[11px] text-text-muted">{tool.preview}</div> : null}
      </summary>
      {open ? <div className="border-t border-border">{payload.isLoading ? <LoadingState /> : payload.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => payload.refetch()} /> : <pre className="max-h-80 overflow-auto p-3 text-[11px] text-text-muted">{pretty(toolSchema(payload.data?.payload))}</pre>}</div> : null}
    </details>
  );
}

function ToolsPanel({ sessionId, requestId, tools, query, setQuery }: { sessionId: string | null; requestId: string | null; tools: BrainDebugSegmentManifestItem[]; query: string; setQuery: (value: string) => void }) {
  const { t } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  const filtered = tools.filter((tool) => `${tool.key ?? ''} ${tool.kind} ${tool.digest}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg/40" data-testid="diagnostics-tools-panel">
      <div className="border-b border-border p-3"><Input aria-label={d.searchTools} placeholder={d.searchTools} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {filtered.length === 0 ? <EmptyState title={d.noTools} icon={Wrench} /> : filtered.map((tool) => <ToolEntry key={`${tool.index}-${tool.digest}`} sessionId={sessionId} requestId={requestId} tool={tool} />)}
      </div>
    </div>
  );
}

export function ConversationDiagnosticsModal({ captureEnabled, onEnableCapture, onClose }: { captureEnabled: boolean; onEnableCapture: () => void; onClose: () => void }) {
  const { t, locale } = useTranslation();
  const d = t.settings.conversationDiagnostics;
  const mobile = useMobile();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const deferredFilters = useDeferredValue(filters);
  const queryFilters = useMemo(() => ({
    search: deferredFilters.search || undefined, from: deferredFilters.from || undefined, to: deferredFilters.to || undefined,
    userId: deferredFilters.userId ? Number(deferredFilters.userId) : undefined, surface: deferredFilters.surface || undefined,
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
  const [mobilePanel, setMobilePanel] = useState<'sessions' | 'tools' | null>(null);

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
  const sessionRail = <SessionRail sessions={sessions} selectedId={sessionId} onSelect={(id) => { setSessionId(id); setMobilePanel(null); }} filters={filters} setFilters={setFilters} hasMore={sessionsQuery.hasNextPage} loadingMore={sessionsQuery.isFetchingNextPage} loadMore={() => void sessionsQuery.fetchNextPage()} />;
  const toolsPanel = <ToolsPanel sessionId={sessionId} requestId={requestId} tools={tools} query={toolQuery} setQuery={setToolQuery} />;

  return (
    <Modal
      title={d.title}
      description={selectedSession ? `${selectedSession.title || selectedSession.id} · ${selectedSession.userName || selectedSession.username}` : d.description}
      icon={Database}
      presentation="fullscreen"
      onClose={onClose}
      headerActions={<div className="flex md:hidden"><button type="button" aria-label={d.sessions} className="p-2 text-text-muted" onClick={() => setMobilePanel('sessions')}><Menu size={18} /></button><button type="button" aria-label={d.tools} className="p-2 text-text-muted" onClick={() => setMobilePanel('tools')}><PanelRightOpen size={18} /></button></div>}
    >
      {!captureEnabled ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle size={14} />{d.captureDisabled}
          <Button className="ml-auto" variant="ghost" onClick={onEnableCapture}>{d.enableCapture}</Button>
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)_20rem]">
        <aside className="hidden min-h-0 md:block">{sessionRail}</aside>
        <main className="flex min-h-0 min-w-0 flex-col">
          {sessionsQuery.isLoading ? <LoadingState /> : sessionsQuery.isError ? <ErrorState message={d.loadError} onRetry={() => sessionsQuery.refetch()} /> : sessions.length === 0 ? <EmptyState title={d.noSessions} icon={MessageSquareText} /> : selectedSession?.requestCount === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="border-b border-warning/40 bg-warning/10 px-4 py-3 text-xs text-warning">{d.legacyWarning}</div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {legacy.isLoading ? <LoadingState /> : legacy.isError ? <ErrorState message={d.loadError} onRetry={() => legacy.refetch()} /> : legacyItems.length === 0 ? <EmptyState title={d.noLegacyData} icon={MessageSquareText} /> : legacyItems.map((item) => (
                  <article key={item.id} className="mb-3 rounded-md border border-border bg-elevated/30 p-3"><div className="mb-2 flex items-center justify-between"><Badge>{item.role}</Badge><span className="text-[10px] text-text-muted">{localDateTime(item.createdAt, locale)}</span></div><pre className="whitespace-pre-wrap text-xs text-text-muted">{pretty(item.content)}</pre></article>
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
                    <section className="rounded-lg border border-border bg-elevated/30 p-3">
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
                      {selectedRequest.errorMessage ? <div className="mt-3 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger">{selectedRequest.errorCode ? `${selectedRequest.errorCode}: ` : ''}{selectedRequest.errorMessage}</div> : null}
                    </section>

                    <div className="flex rounded-md border border-border bg-elevated/30 p-1 xl:hidden" role="tablist" aria-label={d.contentView}>
                      <button type="button" role="tab" aria-selected={mobileContent === 'messages'} onClick={() => setMobileContent('messages')} className={`flex-1 rounded px-3 py-2 text-xs font-semibold ${mobileContent === 'messages' ? 'bg-surface text-text shadow-sm' : 'text-text-muted'}`}>{d.messages}</button>
                      <button type="button" role="tab" aria-selected={mobileContent === 'inspector'} disabled={!selectedSegment} onClick={() => setMobileContent('inspector')} className={`flex-1 rounded px-3 py-2 text-xs font-semibold disabled:opacity-40 ${mobileContent === 'inspector' ? 'bg-surface text-text shadow-sm' : 'text-text-muted'}`}>{d.inspector}</button>
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
                            return <button key={`${segment.index}-${segment.digest}`} type="button" aria-pressed={selectedSegment?.index === segment.index} onClick={() => { setSelectedSegment(segment); setMobileContent('inspector'); }} className={`flex w-full items-start gap-3 border-b border-border p-3 text-left hover:bg-elevated ${selectedSegment?.index === segment.index ? 'bg-elevated' : ''}`}><span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${ROLE_CLASS[itemRole] ?? 'bg-text-muted'}`} /><span className="min-w-0 flex-1"><span className="flex items-center gap-2"><strong className="text-xs text-text">{itemRole}</strong><Badge>{segmentLabel(segment)}</Badge><span className="ml-auto font-mono text-[10px] text-text-muted">~{segment.estimatedTokens}</span></span><span className={`mt-1 line-clamp-2 text-xs ${segment.preview ? 'text-text-muted' : 'font-mono text-[10px] text-text-subtle'}`}>{segment.preview ?? segment.digest}</span></span></button>;
                          })}
                          {visibleMessages < filteredMessages.length ? <div className="p-3"><Button onClick={() => setVisibleMessages((value) => value + 100)}>{d.loadMore}</Button></div> : null}
                        </div>
                      </div>
                      <div data-testid="diagnostics-inspector" className={`${mobileContent === 'messages' ? 'hidden xl:flex' : 'flex'} min-h-0 flex-col rounded-lg border border-border`}>
                        {/* The label is the mobile tab's job; repeating it inside the panel just eats a row. */}
                        <div className="flex items-center gap-2 border-b border-border p-3"><Braces size={14} className="hidden text-accent xl:block" /><strong className="hidden text-xs text-text xl:inline">{d.inspector}</strong><div className="ml-auto flex items-center gap-1"><div className="flex rounded-md border border-border bg-bg p-0.5" role="tablist" aria-label={d.displayMode}><button type="button" role="tab" aria-selected={!inspectorRaw} onClick={() => setInspectorRaw(false)} className={`rounded px-2.5 py-1 text-xs font-semibold ${!inspectorRaw ? 'bg-elevated text-text' : 'text-text-muted'}`}>{d.pretty}</button><button type="button" role="tab" aria-selected={inspectorRaw} onClick={() => setInspectorRaw(true)} className={`rounded px-2.5 py-1 text-xs font-semibold ${inspectorRaw ? 'bg-elevated text-text' : 'text-text-muted'}`}>{d.json}</button></div>{selectedPayload.data ? <Button variant="ghost" icon={Copy} aria-label={d.copy} onClick={() => copy(selectedPayload.data.payload)}>{d.copy}</Button> : null}</div></div>
                        <div className="max-h-[32rem] min-h-0 flex-1 overflow-auto p-3">{selectedSegment ? selectedPayload.isLoading ? <LoadingState /> : selectedPayload.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => selectedPayload.refetch()} /> : inspectorRaw ? <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-text-muted">{pretty(selectedPayload.data?.payload)}</pre> : <PrettyPayload value={selectedPayload.data?.payload} /> : <EmptyState title={d.pickMessage} icon={ListFilter} />}</div>
                      </div>
                    </section>

                    <section className="rounded-lg border border-border">
                      <button type="button" aria-expanded={rawOpen} onClick={() => setRawOpen((value) => !value)} className="flex w-full items-center gap-2 p-3 text-left text-xs font-semibold text-text">{rawOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Braces size={14} className="text-accent" />{d.rawRequest}<span className="ml-auto font-mono text-[10px] text-text-muted">{selectedRequest.segmentBytes} B</span></button>
                      {rawOpen ? <div className="border-t border-border p-3">{raw.isLoading ? <LoadingState /> : raw.isError ? <ErrorState message={d.payloadTooLarge} onRetry={() => raw.refetch()} /> : <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap text-[11px] text-text-muted">{pretty(raw.data?.payload)}</pre>}</div> : null}
                    </section>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </main>
        <aside className="hidden min-h-0 border-l border-border md:block">{toolsPanel}</aside>
      </div>
      {mobile && mobilePanel ? (
        <Modal title={mobilePanel === 'sessions' ? d.sessions : d.tools} presentation="drawer" onClose={() => setMobilePanel(null)}>
          {mobilePanel === 'sessions' ? sessionRail : toolsPanel}
        </Modal>
      ) : null}
    </Modal>
  );
}
