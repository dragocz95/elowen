'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';

type Tone = 'ok' | 'error';
interface ToastItem { id: number; message: string; tone: Tone }
interface ToastCtx { toast: (message: string, tone?: Tone) => void }

const Ctx = createContext<ToastCtx | null>(null);
let nextId = 0;

/** Used until the daemon's config lands, and against a daemon too old to carry the field. Keeps the
 *  value that was hardcoded before the setting existed. */
export const DEFAULT_TOAST_MS = 4500;
/** Floor and ceiling mirroring the daemon's `toastDurationMs` clamp (`src/store/configStore.ts`). The
 *  floor is a correctness bound, not taste: the countdown below divides the elapsed time BY this value,
 *  so a zero would render the progress bar as NaN and dismiss the toast before it could be read — and the
 *  browser cannot assume the daemon that answered GET /config clamps the way this build does. */
export const MIN_TOAST_MS = 2_000;
export const MAX_TOAST_MS = 15_000;

/** Read the configured duration out of the daemon's runtime limits, held inside the bounds above.
 *  Structurally typed rather than importing `RuntimeLimits`, so a caller may pass the limits block of a
 *  config that has not arrived yet (or came from a daemon that never serves the field). */
export function resolveToastDuration(limits?: { toastDurationMs?: number }): number {
  const value = limits?.toastDurationMs;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_TOAST_MS, Math.max(MIN_TOAST_MS, value))
    : DEFAULT_TOAST_MS;
}

function ToastCard({ item, meta, durationMs, dismissLabel, onDismiss }: { item: ToastItem; meta: { Icon: LucideIcon; color: string; title: string }; durationMs: number; dismissLabel: string; onDismiss: () => void }) {
  const { Icon, color, title } = meta;
  const [remaining, setRemaining] = useState(100);
  const paused = useRef(false);
  const edge = `color-mix(in srgb, ${color} 72%, var(--color-on-status))`;
  const onFill = 'var(--color-on-status)';

  useEffect(() => {
    // rAF countdown that drives both the progress bar and auto-dismiss; pauses on hover.
    let elapsed = 0;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      if (!paused.current) elapsed += now - last;
      last = now;
      setRemaining(Math.max(0, 100 - (elapsed / durationMs) * 100));
      if (elapsed >= durationMs) { onDismiss(); return; }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [durationMs, onDismiss]);

  return (
    <div
      role={item.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
      className="pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg py-2.5 pl-3 pr-2.5 sm:gap-3 sm:py-3 sm:pl-4 sm:pr-3"
      style={{
        boxShadow: 'var(--shadow-raised)',
        background: color,
        border: `1px solid ${edge}`,
        animation: 'toast-in 200ms var(--ease-out)',
      }}
    >
      <Icon size={18} aria-hidden className="mt-px shrink-0" style={{ color: onFill }} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold sm:text-sm" style={{ color: onFill }}>{title}</div>
        <div className="mt-0.5 break-words text-[13px] leading-snug sm:text-sm" style={{ color: onFill }}>{item.message}</div>
      </div>
      <button
        type="button"
        aria-label={dismissLabel}
        onClick={onDismiss}
        className="overlay-touch-target -mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-75 transition-opacity hover:bg-on-status/10 hover:opacity-100 sm:h-7 sm:w-7"
        style={{ color: onFill }}
      >
        <X size={15} aria-hidden />
      </button>
      <span className="absolute bottom-0 left-0 h-0.5" style={{ width: `${remaining}%`, backgroundColor: onFill, opacity: 0.4 }} aria-hidden />
    </div>
  );
}

/** `durationMs` is a prop rather than a `useConfig()` call inside this provider on purpose: the provider
 *  mounts above the auth gate and is rendered bare by most component tests, so fetching here would put a
 *  query client in the way of every one of them. `ConfiguredToastProvider` (components/shell) is the one
 *  place that resolves it from the daemon config. */
export function ToastProvider({ children, durationMs = DEFAULT_TOAST_MS }: { children: ReactNode; durationMs?: number }) {
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
  // Stable context value: `toast` never changes identity, so consumers don't re-render every time a
  // toast is shown/dismissed (which would, among other things, churn the SSE subscription in EventBridge).
  const ctx = useMemo(() => ({ toast }), [toast]);
  return (
    <Ctx.Provider value={ctx}>
      {children}
      {/* Placement, layer and safe-area insets all live in `.overlay-toast-dock` (styles/components/
          primitives.css), with the rest of the overlay system: on a phone the stack docks bottom-right
          clear of the advisor launcher, from the tablet breakpoint up it is the conventional top-right
          column. It sits on --z-toast, above even a modal, because a message about what just happened
          has to be readable over the thing that caused it. */}
      <div className="overlay-toast-dock pointer-events-none">
        {items.map((item) => (
          <ToastCard key={item.id} item={item} meta={TONE[item.tone]} durationMs={durationMs} dismissLabel={t.common.dismiss} onDismiss={() => dismiss(item.id)} />
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
