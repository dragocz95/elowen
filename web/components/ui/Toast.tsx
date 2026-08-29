'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import {
  Toast, ToastClose, ToastDescription, ToastProvider as ToastRoot, ToastTitle, ToastViewport, type ToastStatus,
} from './shadcn/toast';

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

/** The app's status policy — the part of a toast that is ours rather than Radix's, kept in one table so
 *  it is read as policy and not rediscovered from four separate ternaries.
 *
 *  `role` and `type` say the same thing to two different mechanisms and must agree. `role` is on the
 *  visible toast, which is what this app has always exposed and what a test can assert; `type` is what
 *  Radix hands its own visually-hidden live region, and it is the one that reliably reaches a screen
 *  reader, because a live region only announces content that arrives AFTER it is in the DOM — a
 *  role="status" element inserted with its text already inside it usually says nothing at all.
 *
 *  There is no per-status DURATION here, and that is the existing policy, not an omission: every status
 *  is held for the same operator-configured time (Settings → Elowen AI → Runtime). If a status ever
 *  needs its own, `duration` on the individual `<Toast>` overrides the provider value. */
const STATUS: Record<Tone, { Icon: LucideIcon; status: ToastStatus; role: 'status' | 'alert'; type: 'foreground' | 'background' }> = {
  ok: { Icon: CheckCircle2, status: 'success', role: 'status', type: 'background' },
  error: { Icon: AlertCircle, status: 'error', role: 'alert', type: 'foreground' },
};

function ToastCard({ item, title, durationMs, dismissLabel, onDismiss }: { item: ToastItem; title: string; durationMs: number; dismissLabel: string; onDismiss: () => void }) {
  const { Icon, status, role, type } = STATUS[item.tone];
  const [remaining, setRemaining] = useState(100);
  const paused = useRef(false);

  useEffect(() => {
    // Drives the progress bar ONLY. Dismissal is Radix's close timer, so the two cannot disagree about
    // when the toast goes — this loop just stops drawing once it has run the bar down.
    let elapsed = 0;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      if (!paused.current) elapsed += now - last;
      last = now;
      setRemaining(Math.max(0, 100 - (elapsed / durationMs) * 100));
      if (elapsed < durationMs) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [durationMs]);

  return (
    <Toast
      status={status}
      role={role}
      type={type}
      open
      onOpenChange={(open) => { if (!open) onDismiss(); }}
      // Radix pauses its close timer on hover, on focus and when the window loses focus. Following it
      // here keeps the bar honest: it used to pause on `mouseenter` only, which already disagreed with
      // the countdown it was drawing whenever the toast was reached by keyboard.
      onPause={() => { paused.current = true; }}
      onResume={() => { paused.current = false; }}
      // Escape belongs to the topmost overlay, not to the toast. Radix would otherwise clear the toasts
      // on the same keypress that closes a modal — including the toast that modal had just raised,
      // which is the exact message --z-toast exists to keep on screen.
      onEscapeKeyDown={(event) => event.preventDefault()}
    >
      <Icon size={18} aria-hidden className="mt-px shrink-0" />
      <div className="min-w-0 flex-1">
        <ToastTitle>{title}</ToastTitle>
        <ToastDescription>{item.message}</ToastDescription>
      </div>
      <ToastClose aria-label={dismissLabel}>
        <X size={15} aria-hidden />
      </ToastClose>
      {/* A wash of the INHERITED ink, so the countdown reads on whichever status fill the card carries
          and follows a skin that repaints the pair. */}
      <span className="absolute bottom-0 left-0 h-0.5 bg-current/40" style={{ width: `${remaining}%` }} aria-hidden />
    </Toast>
  );
}

/** `durationMs` is a prop rather than a `useConfig()` call inside this provider on purpose: the provider
 *  mounts above the auth gate and is rendered bare by most component tests, so fetching here would put a
 *  query client in the way of every one of them. `ConfiguredToastProvider` (components/shell) is the one
 *  place that resolves it from the daemon config. */
export function ToastProvider({ children, durationMs = DEFAULT_TOAST_MS }: { children: ReactNode; durationMs?: number }) {
  const { t } = useTranslation();
  const TITLE: Record<Tone, string> = { ok: t.common.success, error: t.common.error };
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
      {/* The configured duration is set once, on the Radix provider, because it applies to every status
          alike. Radix renders each toast into the viewport below via its own portal — into that node,
          not into <body> — so the dock stays a sibling of the app tree rather than of an open modal,
          and nothing can trap it inside the modal's stacking context. */}
      {/* Radix names both the per-toast announcement and the viewport landmark, and both default to
          English. They are the only words a screen-reader user hears before the message itself, so they
          follow the app's language like every other piece of copy. `{hotkey}` inside the landmark name
          is Radix's own placeholder — it substitutes the key combination that focuses the viewport. */}
      <ToastRoot duration={durationMs} label={t.common.notification}>
        {children}
        {items.map((item) => (
          <ToastCard
            key={item.id}
            item={item}
            title={TITLE[item.tone]}
            durationMs={durationMs}
            dismissLabel={t.common.dismiss}
            onDismiss={() => dismiss(item.id)}
          />
        ))}
        <ToastViewport label={t.common.notifications} />
      </ToastRoot>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
