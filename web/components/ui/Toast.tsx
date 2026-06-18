'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

type Tone = 'ok' | 'error';
interface ToastItem { id: number; message: string; tone: Tone }
interface ToastCtx { toast: (message: string, tone?: Tone) => void }

const Ctx = createContext<ToastCtx | null>(null);
let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const TONE = {
    ok: { Icon: CheckCircle2, color: '#10b981', title: t.common.success },
    error: { Icon: AlertCircle, color: 'var(--color-danger)', title: t.common.error },
  };
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((message: string, tone: Tone = 'ok') => {
    const id = nextId++;
    setItems((xs) => [...xs, { id, message, tone }]);
    setTimeout(() => dismiss(id), 4500);
  }, [dismiss]);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[22rem] max-w-[calc(100vw-2.5rem)] flex-col gap-2.5">
        {items.map((item) => {
          const { Icon, color, title } = TONE[item.tone];
          return (
            <div
              key={item.id}
              role="status"
              className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-elevated p-3.5"
              style={{ boxShadow: 'var(--shadow-raised)', animation: 'toast-in 200ms var(--ease-out)' }}
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${color}1f`, color }}>
                <Icon size={15} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text">{title}</div>
                <div className="mt-0.5 break-words text-sm text-text-muted">{item.message}</div>
              </div>
              <button
                type="button"
                aria-label={t.common.dismiss}
                onClick={() => dismiss(item.id)}
                className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface hover:text-text"
              >
                <X size={14} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
