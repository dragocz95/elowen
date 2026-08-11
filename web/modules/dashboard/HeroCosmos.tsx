'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { ShieldQuestion, Coins, Radio, AlarmClock, type LucideIcon } from 'lucide-react';
import { currentMonthBounds } from './metrics';
import { buildUsageSummary } from '../stats/usageBars';
import { nextCronRun } from '../../lib/cron';
import { appendFilament, lightFilament } from '../../lib/cosmosFilaments';
import { formatCost } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import {
  usePendingAsks, useEscalations, useModelUsage, useUsageByDay, useSessionInfos, useCronJobs, useMe,
} from '../../lib/queries';
import type { SessionInfo } from '../../lib/types';
import { ElowenPresence } from './ElowenPresence';
import type { AgentPresenceState } from './useAgentPresence';

/** The hero mini-cosmos: the Elowen presence mascot as the core of a small orbital field whose four
 *  pods carry the operational signals (decisions, agents, next run, month cost). Pods are links —
 *  the dashboard navigates, it doesn't configure — tied to the core by the same curved filaments as
 *  the settings constellation. Below the orbit threshold the pods collapse into beam-docked rows. */

/** 0.5rem slack under the hero's 26rem cosmos column so subpixel rounding can't flap the mode. */
const ORBIT_MIN_WIDTH_PX = 408;
const ORBIT_MIN_HEIGHT_PX = 336;

type PodId = 'decisions' | 'agents' | 'cron' | 'cost';

/** Corner placement (screen coords, y down) keeps mid-height clear of the mascot's own orbit rings
 *  and the field's horizontal extremes clear of the hero's text column. */
const ANGLES_DEG: Record<PodId, number> = {
  agents: -128,
  decisions: -52,
  cost: 52,
  cron: 128,
};

const POD_W = 184; // px mirror of the 11.5rem .hero-cosmos__pod width

interface HeroPod {
  id: PodId;
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  href: string;
  alert?: boolean;
}

export function HeroCosmos({ now, state, presenceLabel }: {
  now: number;
  state: AgentPresenceState;
  presenceLabel: string;
}) {
  const { t, locale } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const podsRef = useRef<HTMLElement>(null);
  const alertRef = useRef(false);

  const asks = usePendingAsks();
  const escalations = useEscalations();
  const decisions = (asks.data?.length ?? 0) + escalations.length;

  const infos = useSessionInfos();
  const agents = (infos.data ?? []).filter((session: SessionInfo) => session.role === 'agent').length;

  const me = useMe();
  const jobs = useCronJobs(me.data?.user?.is_admin ?? false);
  const next = useMemo(() => {
    let best: { at: number; name: string } | null = null;
    for (const job of jobs.data ?? []) {
      const at = nextCronRun(job, now);
      if (at != null && (!best || at < best.at)) best = { at, name: job.name };
    }
    return best;
  }, [jobs.data, now]);

  const monthBounds = useMemo(() => currentMonthBounds(now), [now]);
  const monthly = useModelUsage(undefined, monthBounds);
  const daily = useUsageByDay(undefined, 7);
  const summary = buildUsageSummary(monthly.data);
  const days = useMemo(() => {
    const byDay = new Map((daily.data ?? []).map((day) => [day.day, day]));
    return Array.from({ length: 7 }, (_, index) => {
      const key = new Date(now - (6 - index) * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(key) ?? { day: key, tokens: 0, cost: null };
    });
  }, [daily.data, now]);
  const today = days[days.length - 1];
  const todayLabel = today.cost != null ? formatCost(today.cost) : '—';

  const pods: HeroPod[] = [
    {
      id: 'decisions',
      icon: ShieldQuestion,
      label: t.dashboard.signalDecisionsWaiting,
      value: String(decisions),
      detail: decisions > 0 ? t.dashboard.decisionsUnit : t.dashboard.allClear,
      href: '/p/agents/escalations',
      alert: decisions > 0,
    },
    {
      id: 'agents',
      icon: Radio,
      label: t.dashboard.signalAgentsActive,
      value: String(agents),
      detail: agents > 0 ? t.dashboard.agentsWorkingUnit : t.dashboard.allQuiet,
      href: '/p/agents/sessions',
    },
    {
      id: 'cron',
      icon: AlarmClock,
      label: t.dashboard.nextRunLabel,
      value: next ? new Date(next.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—',
      detail: next?.name ?? t.dashboard.noCron,
      href: '/settings?section=cron',
    },
    {
      id: 'cost',
      icon: Coins,
      label: t.dashboard.signalMonthCost,
      value: summary.totalCostLabel,
      detail: `${t.dashboard.last7d} · ${t.dashboard.today.replace('{cost}', todayLabel)}`,
      href: '/stats',
    },
  ];

  useEffect(() => {
    const root = rootRef.current;
    const svg = svgRef.current;
    const podsLayer = podsRef.current;
    if (!root || !svg || !podsLayer) return;

    const layout = () => {
      const podEls = Array.from(podsLayer.querySelectorAll<HTMLElement>(':scope > .hero-cosmos__pod'));
      podEls.forEach((pod, i) => pod.style.setProperty('--i', String(i)));
      const w = root.clientWidth;
      const h = root.clientHeight;
      const orbit = w >= ORBIT_MIN_WIDTH_PX && h >= ORBIT_MIN_HEIGHT_PX && podEls.length > 0;
      root.dataset.mode = orbit ? 'orbit' : 'stack';
      svg.replaceChildren();
      if (!orbit) {
        for (const pod of podEls) {
          pod.style.left = '';
          pod.style.top = '';
          pod.style.removeProperty('--fx');
          pod.style.removeProperty('--fy');
        }
        return;
      }
      const cx = w / 2;
      const cy = h / 2;
      const rx = Math.min(w / 2 - POD_W / 2 - 8, w * 0.38);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      for (const pod of podEls) {
        const id = pod.dataset.pod as PodId;
        const angle = (ANGLES_DEG[id] * Math.PI) / 180;
        const ry = Math.min(h / 2 - pod.offsetHeight / 2 - 8, h * 0.4);
        const x = cx + rx * Math.cos(angle);
        const y = cy + ry * Math.sin(angle);
        pod.style.left = `${x}px`;
        pod.style.top = `${y}px`;
        pod.style.setProperty('--fx', `${cx - x}px`);
        pod.style.setProperty('--fy', `${cy - y}px`);
        // Filament: the same gently curved base + drifting flow overlay as every other cosmos field.
        appendFilament(svg, { x: cx, y: cy }, { x, y }, {
          pod: id,
          index: pod.style.getPropertyValue('--i'),
          ...(alertRef.current && id === 'decisions' ? { extraClass: 'hero-fil--alert' } : {}),
        });
      }
    };

    layout();
    root.classList.add('hero-cosmos--enter');
    const resize = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(layout) : null;
    resize?.observe(root);

    // Hovering a pod lights up its filament and dims the others.
    const onOver = (event: PointerEvent) => {
      const pod = event.target instanceof Element ? event.target.closest<HTMLElement>('.hero-cosmos__pod') : null;
      lightFilament(svg, pod?.dataset.pod ?? null);
    };
    const onOut = () => lightFilament(svg, null);
    podsLayer.addEventListener('pointerover', onOver);
    podsLayer.addEventListener('pointerleave', onOut);

    return () => {
      resize?.disconnect();
      podsLayer.removeEventListener('pointerover', onOver);
      podsLayer.removeEventListener('pointerleave', onOut);
    };
  }, []);

  // The waiting state re-tones the decisions filament amber to match the presence aura. The layout
  // pass re-applies it via alertRef because a redraw recreates the paths.
  useEffect(() => {
    alertRef.current = state === 'needs_input';
    const svg = svgRef.current;
    if (!svg) return;
    for (const path of svg.querySelectorAll('path')) {
      path.classList.toggle('hero-fil--alert', alertRef.current && path.dataset.pod === 'decisions');
    }
  }, [state]);

  return (
    <div ref={rootRef} className="hero-cosmos" data-mode="stack" data-testid="hero-cosmos">
      <svg ref={svgRef} className="hero-cosmos__filaments" aria-hidden="true" />
      <div className="hero-cosmos__core">
        <ElowenPresence state={state} label={presenceLabel} />
      </div>
      <nav ref={podsRef} className="hero-cosmos__pods" aria-label={t.dashboard.attention}>
        {pods.map((pod) => (
          <Link
            key={pod.id}
            href={pod.href}
            data-pod={pod.id}
            className={`hero-cosmos__pod${pod.alert ? ' hero-cosmos__pod--alert' : ''}`}
          >
            <span className="hero-cosmos__orb"><pod.icon size={14} aria-hidden /></span>
            <span className="hero-cosmos__body">
              <span className="hero-cosmos__label">{pod.label}</span>
              <span className="hero-cosmos__value">{pod.value}</span>
              <span className="hero-cosmos__detail">{pod.detail}</span>
              {pod.id === 'cost' ? <Sparkline days={days} /> : null}
            </span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Seven-day token sparkline carried over from the retired attention rail. */
function Sparkline({ days }: { days: { day: string; tokens: number }[] }) {
  const max = Math.max(1, ...days.map((day) => day.tokens));
  return (
    <span className="mt-1.5 flex h-5 items-end gap-0.5" aria-hidden>
      {days.map((day, index) => (
        <span
          key={day.day}
          className={`flex-1 rounded-t-sm transition-[height] duration-500 ${index === days.length - 1 ? 'bg-accent' : 'bg-border-strong/70'}`}
          style={{ height: `${Math.max(10, (day.tokens / max) * 100)}%` }}
        />
      ))}
    </span>
  );
}
