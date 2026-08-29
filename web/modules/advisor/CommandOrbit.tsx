'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compass, Cpu, Hammer, MessageSquarePlus, PenLine, Shrink, Workflow, X, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { focusOverlaySurface, useOverlayIsolation } from '../../components/ui/overlayStack';
import { Dialog, DialogContent } from '../../components/ui/shadcn/dialog';
import { useMobileViewport } from '../../lib/useMobile';
import { MascotGlyph } from '../../components/ui/SpatialMascot';
import { appendFilament, lightFilament } from '../../lib/cosmosFilaments';
import type { SlashCommandDef } from '../../lib/types';
import { useBrainChat } from './BrainChatProvider';

/** The owl's command field: the mascot as the core of an orbital field whose pods are the handful of
 *  slash commands worth reaching for mid-conversation. It opens as an OVERLAY rather than living in the
 *  telemetry rail, because the rail is 15rem wide (18rem as a phone drawer) and an orbital field needs
 *  roughly 26rem before its pods start colliding with the core.
 *
 *  The pods come from the daemon's catalog (`GET /brain/commands`, already surface-filtered) and execute
 *  through the controller's own `runSlash` — the field is a second door onto the composer's slash menu,
 *  never a second implementation of it. A curated command that this account's surface does not expose
 *  simply has no pod. */

/** The commands worth a pod, in orbit order. Anything else stays in the composer's `/` menu. */
const FIELD_COMMANDS: readonly { name: string; icon: LucideIcon }[] = [
  { name: 'plan', icon: Compass },
  { name: 'build', icon: Hammer },
  { name: 'workflow', icon: Workflow },
  { name: 'compact', icon: Shrink },
  { name: 'rename', icon: PenLine },
  { name: 'new', icon: MessageSquarePlus },
  { name: 'model', icon: Cpu },
];

/** px mirrors of the pod widths in components.css — the layout needs them before the pods are measured. */
const ORBIT_POD_W = 184;
const ARC_POD_W = 96;
/** The sweep the arc layout spreads a group over, and the cosine of its end angle — the horizontal radius
 *  is capped by that cosine so a pod at either end stays fully on screen. */
const ARC_FROM_DEG = 155;
const ARC_TO_DEG = 25;
const ARC_END_COS = Math.abs(Math.cos((ARC_FROM_DEG * Math.PI) / 180));
const ARC_INNER_RY = 150;
const ARC_OUTER_RY = 350;
/** Vertical band the arc layout reserves above its outer sweep for the owl itself. */
const ARC_CORE_BAND = 170;
/** No phone pod: a fourth action would not fit either sweep without crowding, and the model picker is one
 *  tap away in the chat header on mobile — unlike compacting or renaming, which live only in the slashes. */
const ARC_OMITTED = 'model';

export interface Placement { pod: HTMLElement; x: number; y: number }

/** Even ring around the core (desktop / tablet): first pod at the top, the rest clockwise.
 *  Exported for the geometry test — jsdom has no layout, so the arrangement is verified as pure math. */
export function ringPlacements(pods: HTMLElement[], cx: number, cy: number, width: number, height: number): Placement[] {
  const rx = Math.min(width / 2 - ORBIT_POD_W / 2 - 24, 340);
  const ry = Math.min(height / 2 - 56, 240);
  return pods.map((pod, index) => {
    const radians = ((-90 + (360 * index) / pods.length) * Math.PI) / 180;
    return { pod, x: cx + rx * Math.cos(radians), y: cy + ry * Math.sin(radians) };
  });
}

/** Bottom-anchored thumb arc (phones). A shrunk copy of the desktop ring would glue its pods together on
 *  a 390px screen, and a ring centred in the viewport would put half the commands out of thumb reach — so
 *  the pods ride two sweeps rising from the bottom edge instead. The mode pods take the inner sweep (the
 *  shortest reach), the actions the far taller outer one; three pods per sweep is what a phone's width
 *  carries side by side, and the vertical gap between the sweeps is what keeps the two ends apart. */
export function arcPlacements(pods: HTMLElement[], width: number, anchorY: number): Placement[] {
  const cx = width / 2;
  const cap = (width / 2 - ARC_POD_W / 2 - 10) / ARC_END_COS;
  const sweep = (group: HTMLElement[], rx: number, ry: number): Placement[] =>
    group.map((pod, index) => {
      const ratio = group.length > 1 ? index / (group.length - 1) : 0.5;
      const radians = ((ARC_FROM_DEG + (ARC_TO_DEG - ARC_FROM_DEG) * ratio) * Math.PI) / 180;
      return { pod, x: cx + rx * Math.cos(radians), y: anchorY - ry * Math.sin(radians) };
    });
  return [
    ...sweep(pods.filter((pod) => pod.dataset.kind === 'mode'), Math.min(115, cap), ARC_INNER_RY),
    ...sweep(pods.filter((pod) => pod.dataset.kind !== 'mode'), Math.min(125, cap), ARC_OUTER_RY),
  ];
}

export function CommandOrbit({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { commands, runSlash, workMode, busy } = useBrainChat();
  const mobile = useMobileViewport();
  const [mounted, setMounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const podsRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);
  // The layout branches on the viewport, so the dialog waits for the first measurement rather than
  // mounting the desktop ring on a phone for one commit.
  const ready = mounted && mobile !== undefined;
  const { restoreFocus } = useOverlayIsolation({ enabled: ready, rootRef: overlayRef });

  const field = t.brainChat.commandField;
  const labels: Record<string, string> = {
    plan: t.brainChat.workMode.plan,
    build: t.brainChat.workMode.build,
    workflow: t.brainChat.workMode.workflow,
    compact: field.compact,
    rename: field.rename,
    new: field.newChat,
    model: field.model,
  };
  const pods = FIELD_COMMANDS.flatMap(({ name, icon }) => {
    if (mobile && name === ARC_OMITTED) return [];
    const command = commands.find((c) => c.name === name);
    return command ? [{ command, icon, label: labels[name] ?? name }] : [];
  });
  const podKey = pods.map((pod) => pod.command.name).join(',');

  useEffect(() => {
    if (!ready) return;
    const root = fieldRef.current;
    const svg = svgRef.current;
    const podsLayer = podsRef.current;
    const core = coreRef.current;
    if (!root || !svg || !podsLayer || !core) return;

    const layout = () => {
      const podEls = Array.from(podsLayer.querySelectorAll<HTMLElement>(':scope > .cmd-orbit__pod'));
      podEls.forEach((pod, index) => pod.style.setProperty('--i', String(index)));
      const width = root.clientWidth;
      const height = root.clientHeight;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren();
      if (podEls.length === 0) return;
      // A short viewport (a phone in landscape) cannot hold the arc at full size; scaling the whole field
      // about its bottom edge keeps the arrangement — and the pods' proportions — intact.
      const scale = mobile
        ? Math.min(1, Math.max(0.7, height / (ARC_OUTER_RY + 40 + ARC_CORE_BAND)))
        : 1;
      root.style.setProperty('--k', String(scale));
      const coreBox = core.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      // Measured rather than assumed: the core sits centred on desktop and near the top on a phone, and
      // the filaments start at whichever it is.
      const cx = (coreBox.left - rootBox.left + coreBox.width / 2) / scale;
      const cy = (coreBox.top - rootBox.top + coreBox.height / 2) / scale;
      const placements = mobile
        ? arcPlacements(podEls, width, height - 8)
        : ringPlacements(podEls, cx, cy, width, height);
      for (const { pod, x, y } of placements) {
        pod.style.left = `${x}px`;
        pod.style.top = `${y}px`;
        pod.style.setProperty('--fx', `${cx - x}px`);
        pod.style.setProperty('--fy', `${cy - y}px`);
        appendFilament(svg, { x: cx, y: cy }, { x, y }, {
          pod: pod.dataset['pod'] ?? '',
          index: pod.style.getPropertyValue('--i'),
        });
      }
    };

    layout();
    root.classList.add('cmd-orbit--enter');
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    resize?.observe(root);

    const onOver = (event: PointerEvent) => {
      const pod = event.target instanceof Element ? event.target.closest<HTMLElement>('.cmd-orbit__pod') : null;
      lightFilament(svg, pod?.dataset['pod'] ?? null);
    };
    const onOut = () => lightFilament(svg, null);
    podsLayer.addEventListener('pointerover', onOver);
    podsLayer.addEventListener('pointerleave', onOut);
    return () => {
      resize?.disconnect();
      podsLayer.removeEventListener('pointerover', onOver);
      podsLayer.removeEventListener('pointerleave', onOut);
    };
  }, [ready, mobile, podKey]);

  if (!ready) return null;

  // A mode switch keeps the field open — the mark moving to the chosen pod IS the feedback. Every other
  // command opens its own surface (a dialog, the model picker, a toast), so the field steps aside.
  const run = (command: SlashCommandDef): void => {
    runSlash(command);
    if (command.kind !== 'mode') onClose();
  };

  return createPortal(
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <div
        ref={overlayRef}
        className="overlay-layer-modal fixed inset-0"
        // Radix's modal content sets `pointer-events: none` on <body> and re-enables them on itself;
        // this layer would inherit the block and the backdrop below would stop answering the click that
        // dismisses the field. Opting back in is what `DialogOverlay` does for the same reason.
        style={{ pointerEvents: 'auto' }}
      >
        <div
          data-testid="command-orbit-backdrop"
          className="absolute inset-0 bg-bg/80"
          style={{
            backdropFilter: 'var(--command-orbit-backdrop-filter, none)',
            WebkitBackdropFilter: 'var(--command-orbit-backdrop-filter, none)',
          }}
          onClick={onClose}
          aria-hidden
        />
        <DialogContent
          ref={dialogRef}
          // The field's shape is its own (`.cmd-orbit`, command-orbit.css) — a viewport-sized,
          // pointer-transparent frame the pods and the close control opt back into — so the primitive's
          // geometry variants are declined rather than merged over the top of it.
          presentation={null}
          aria-label={field.title}
          aria-describedby={undefined}
          data-testid="command-orbit"
          data-layout={mobile ? 'arc' : 'orbit'}
          className="cmd-orbit"
          // Restated inline because Radix re-enables pointer events on the layer it dismisses from, and
          // an inline style beats `.cmd-orbit`'s own rule. Without it this frame — which covers the
          // viewport — would swallow every press meant for the backdrop underneath it.
          style={{ pointerEvents: 'none' }}
          // The backdrop above already owns dismissal, and it is the only owner that knows a nested
          // overlay's backdrop must not close its parent.
          onInteractOutside={(event) => event.preventDefault()}
          // Focus policy stays the app's: the surface (or whatever asked for `[data-autofocus]`) on the
          // way in, the opener on the way out — Radix would take the first pod and then hand focus to a
          // trigger that does not exist.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (dialogRef.current) focusOverlaySurface(dialogRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <p className="cmd-orbit__hint">{field.hint}</p>
          <button
            type="button"
            onClick={onClose}
            data-testid="command-orbit-close"
            aria-label={t.common.close}
            title={t.common.close}
            className="cmd-orbit__close overlay-touch-target"
          >
            <X size={18} aria-hidden />
          </button>
          <div ref={fieldRef} className="cmd-orbit__field">
            <svg ref={svgRef} className="cmd-orbit__filaments" aria-hidden />
            <div ref={coreRef} className="cmd-orbit__core">
              <MascotGlyph state={busy ? 'saving' : 'idle'} />
            </div>
            <div ref={podsRef} className="cmd-orbit__pods">
              {pods.map(({ command, icon: Icon, label }) => {
                const isMode = command.kind === 'mode';
                const active = isMode && command.name === workMode;
                return (
                  <button
                    key={command.name}
                    type="button"
                    data-pod={command.name}
                    data-kind={command.kind}
                    data-testid={`command-orbit-pod-${command.name}`}
                    aria-pressed={isMode ? active : undefined}
                    aria-label={active ? `${label} — ${field.activeMode}` : label}
                    className={`cmd-orbit__pod${active ? ' cmd-orbit__pod--active' : ''}`}
                    onClick={() => run(command)}
                  >
                    <span className="cmd-orbit__orb"><Icon size={18} aria-hidden /></span>
                    <span className="cmd-orbit__label">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </div>
    </Dialog>,
    document.body,
  );
}
