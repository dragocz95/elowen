'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Send, Plus, ChevronDown, Wrench } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '../../lib/i18n';
import { useBrainSessions } from '../../lib/queries';
import { orcaClient, BASE } from '../../lib/orcaClient';
import type { BrainMessage } from '../../lib/types';

interface Turn { role: 'user' | 'assistant'; text: string; tools?: string[] }

/** One rendered bubble: user turns as plain accent-tinted text, assistant turns as sanitized markdown
 *  (the same marked + DOMPurify pairing the project editor's preview uses). */
function Bubble({ turn }: { turn: Turn }) {
  const html = useMemo(
    () => (turn.role === 'assistant' ? DOMPurify.sanitize(marked.parse(turn.text, { async: false }) as string) : ''),
    [turn.role, turn.text],
  );
  if (turn.role === 'user') {
    return (
      <div className="ml-8 self-end rounded-lg rounded-br-sm border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text">
        {turn.text}
      </div>
    );
  }
  return (
    <div className="mr-4 flex flex-col gap-1 self-start">
      {turn.tools?.length ? (
        <span className="flex flex-wrap gap-1">
          {turn.tools.map((name, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-elevated px-2 py-0.5 font-mono text-tiny text-text-muted">
              <Wrench size={9} aria-hidden />{name}
            </span>
          ))}
        </span>
      ) : null}
      {turn.text ? (
        <div className="chat-markdown rounded-lg rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-text" dangerouslySetInnerHTML={{ __html: html }} />
      ) : null}
    </div>
  );
}

/** The docked brain chat: the same server-side brain `orca chat` talks to, in the web. Streams over
 *  the daemon's SSE, keeps multiple conversations (new/resume via the session picker). */
export function BrainChat() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sessions = useBrainSessions();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const active = sessions.data?.find((s) => s.active);

  const loadHistory = async () => {
    const msgs = await orcaClient.brainMessages();
    setTurns(msgs.filter((m: BrainMessage) => m.text).map((m: BrainMessage) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text })));
  };

  // Boot: start (resume) the brain, load history, open the stream. Re-runs when the conversation flips.
  const connect = async () => {
    esRef.current?.close();
    setReady(false);
    await orcaClient.brainStart({});
    await loadHistory();
    const es = new EventSource(`${BASE}/brain/stream`);
    es.addEventListener('text', (e) => {
      const { delta } = JSON.parse((e as MessageEvent).data) as { delta: string };
      setTurns((cur) => {
        const last = cur[cur.length - 1];
        if (last?.role === 'assistant') return [...cur.slice(0, -1), { ...last, text: last.text + delta }];
        return [...cur, { role: 'assistant', text: delta }];
      });
    });
    es.addEventListener('tool', (e) => {
      const { name } = JSON.parse((e as MessageEvent).data) as { name: string };
      setTurns((cur) => {
        const last = cur[cur.length - 1];
        if (last?.role === 'assistant') return [...cur.slice(0, -1), { ...last, tools: [...(last.tools ?? []), name] }];
        return [...cur, { role: 'assistant', text: '', tools: [name] }];
      });
    });
    es.addEventListener('idle', () => { setBusy(false); void qc.invalidateQueries({ queryKey: ['brain-sessions'] }); });
    esRef.current = es;
    setReady(true);
  };

  useEffect(() => {
    void connect().catch(() => setReady(true)); // surface the input even if the brain is unwired
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setTurns((cur) => [...cur, { role: 'user', text }]);
    try { await orcaClient.brainSend(text); } catch { setBusy(false); }
  };

  const switchSession = async (opts: { session?: string; fresh?: boolean }) => {
    setPickerOpen(false);
    await orcaClient.brainStart(opts);
    await qc.invalidateQueries({ queryKey: ['brain-sessions'] });
    await connect();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Conversation bar: current title + picker + new chat. */}
      <div className="relative flex items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-text transition-colors hover:bg-elevated"
        >
          <span className="truncate">{active?.title || t.brainChat.newChat}</span>
          <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => void switchSession({ fresh: true })}
          aria-label={t.brainChat.newChat}
          title={t.brainChat.newChat}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
        >
          <Plus size={16} aria-hidden />
        </button>
        {pickerOpen ? (
          <div className="absolute left-2 right-2 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-elevated p-1 shadow-lg">
            {(sessions.data ?? []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void switchSession({ session: s.id })}
                className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface ${s.active ? 'bg-surface' : ''}`}
              >
                <span className="truncate text-sm text-text">{s.title || t.brainChat.untitled}</span>
                <span className="truncate font-mono text-tiny text-text-muted">{s.model}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Messages. */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {turns.length === 0 && ready ? (
          <p className="m-auto max-w-[220px] text-center text-xs text-text-muted">{t.brainChat.empty}</p>
        ) : null}
        {turns.map((turn, i) => <Bubble key={i} turn={turn} />)}
        {busy ? <span className="ml-1 animate-pulse text-xs text-text-muted">{t.brainChat.thinking}</span> : null}
      </div>

      {/* Composer. */}
      <form
        className="flex items-end gap-2 border-t border-border p-2"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }}
          rows={Math.min(5, input.split('\n').length)}
          placeholder={t.brainChat.placeholder}
          className="max-h-40 flex-1 resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent"
        />
        <button
          type="submit"
          disabled={!input.trim() || busy}
          aria-label={t.brainChat.send}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-accent bg-accent/15 text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
        >
          <Send size={16} aria-hidden />
        </button>
      </form>
    </div>
  );
}
