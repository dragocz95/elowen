'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

type Tone = 'ok' | 'error';
interface ToastItem { id: number; message: string; tone: Tone }
interface ToastCtx { toast: (message: string, tone?: Tone) => void }

const Ctx = createContext<ToastCtx | null>(null);
let nextId = 0;
const TOAST_MS = 4500;

function ToastCard({ item, meta, dismissLabel, onDismiss }: { item: ToastItem; meta: { Icon: LucideIcon; color: string; title: string }; dismissLabel: string; onDismiss: () => void }) {
  const { Icon, color, title } = meta;
  const [remaining, setRemaining] = useState(100);
  const paused = useRef(false);

  useEffect(() => {
    // rAF countdown that drives both the progress bar and auto-dismiss; pauses on hover.
    let elapsed = 0;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      if (!paused.current) elapsed += now - last;
      last = now;
      setRemaining(Math.max(0, 100 - (elapsed / TOAST_MS) * 100));
      if (elapsed >= TOAST_MS) { onDismiss(); return; }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      className="pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-lg border border-border bg-surface py-3 pl-4 pr-3"
      style={{ boxShadow: 'var(--shadow-raised)', borderLeft: `3px solid ${color}`, animation: 'toast-in 200ms var(--ease-out)' }}
    >
      <Icon size={20} aria-hidden className="mt-px shrink-0" style={{ color }} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-text">{title}</div>
        <div className="mt-0.5 break-words text-sm leading-snug text-text-muted">{item.message}</div>
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="-mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
      >
        <X size={15} aria-hidden />
      </button>
      <span className="absolute bottom-0 left-0 h-0.5" style={{ width: `${remaining}%`, backgroundColor: color, opacity: 0.5 }} aria-hidden />
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const TONE: Record<Tone, { Icon: LucideIcon; color: string; title: string }> = {
    ok: { Icon: CheckCircle2, color: 'var(--color-success)', title: t.common.success },
    error: { Icon: AlertCircle, color: 'var(--color-danger)', title: t.common.error },
  };
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, tone: Tone = 'ok') => {
    const id = nextId++;
    setItems((xs) => [...xs, { id, message, tone }]);
  }, []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col gap-2.5">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} meta={TONE[item.tone]} dismissLabel={t.common.dismiss} onDismiss={() => dismiss(item.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
