'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef } from 'react';
import { Coins, Radio, AlarmClock, type LucideIcon } from 'lucide-react';
import { currentMonthBounds } from './metrics';
import { buildUsageSummary } from '../../lib/usageBars';
import { nextCronRun } from '../../lib/cron';
import { appendFilament, lightFilament } from '../../lib/cosmosFilaments';
import { formatCost } from '../../lib/format';
import { useTranslation } from '../../lib/i18n';
import { usePulse, useModelUsage, useUsageByDay, useCronJobs, useMe, usePluginPresent } from '../../lib/queries';
import { Sparkline as SharedSparkline } from '../../components/ui/Sparkline';
import { useShellProfile } from '../../lib/shellProfile';
import { ElowenPresence } from './ElowenPresence';
import type { PresenceState } from './usePresence';

/** The hero mini-cosmos: the Elowen presence mascot as the core of a small orbital field whose four
 *  pods carry the operational signals (who is working, next run, month cost). Pods are links —
 *  the dashboard navigates, it doesn't configure — tied to the core by the same curved filaments as
 *  the settings constellation. Below the orbit threshold the pods collapse into beam-docked rows.
 *
 *  Under a `command` shell profile the field is a `grid` instead: the same three pods, the same links
 *  and the same readings, laid out as plain stat cards with no core, no filaments and no orbit. That
 *  profile's whole premise is that the interface is a dashboard rather than a place, and an orbiting
 *  mascot is the single loudest contradiction of it. It is a MODE and not a fork — one component, one
 *  set of pods, one source for each figure — and the layout effect below simply has nothing to do in
 *  it, which is also why the pods can then be positioned by CSS alone. */

/** 0.5rem slack under the hero's 20rem cosmos column and its 18rem reserved height, so subpixel
 *  rounding cannot flap the mode. Both mirror HeroNowTile's `@3xl:` grid; the pair moved down together
 *  when the column stopped being sized for a page that was afterwards shrunk to ~72%.
 *
 *  Orbit mode's own `min-height` (20rem, dashboard-cosmos.css) sits ABOVE the height threshold on
 *  purpose: entering orbit must not immediately measure a box that fails the test that let it in. */
const ORBIT_MIN_WIDTH_PX = 312;
const ORBIT_MIN_HEIGHT_PX = 280;

type PodId = 'people' | 'cron' | 'cost';

/** Corner placement (screen coords, y down) keeps mid-height clear of the mascot's own orbit rings
 *  and the field's horizontal extremes clear of the hero's text column.
 *
 *  There used to be a fourth pod. `decisions` and `agents` both read the `agents` plugin's API and
 *  went with it; `people` replaces them with the question this instance can still answer — who is
 *  working right now — from the same pulse the tile below the hero draws. */
const ANGLES_DEG: Record<PodId, number> = {
  people: -128,
  cost: 52,
  cron: 128,
};

/** Without the cron plugin only people + cost remain; their normal corners would leave the field
 *  lopsided, so the pair moves to a balanced diagonal instead. */
const REDUCED_ANGLES_DEG: Partial<Record<PodId, number>> = {
  people: -128,
  cost: 52,
};

const POD_W = 184; // px mirror of the 11.5rem .hero-cosmos__pod width

interface HeroPod {
  id: PodId;
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  href?: string;
  alert?: boolean;
}

export function HeroCosmos({ now, state, presenceLabel }: {
  now: number;
  state: PresenceState;
  presenceLabel: string;
}) {
  const { t, locale } = useTranslation();
  const flat = useShellProfile() === 'command';
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const podsRef = useRef<HTMLElement>(null);
  const alertRef = useRef(false);

  // Who is around, from the daemon's LIVE view of running turns rather than anything inferred from
  // history. This is the same request the pulse tile below makes, so the two cannot disagree about
  // who is working — react-query serves both from one cache entry.
  const pulse = usePulse();
  const people = pulse.data?.people ?? [];
  const working = people.filter((person) => person.working).length;
  // Guarded section by section rather than only at `data`: the response is an external payload, and a
  // pod that reads "0 turns" is a far better failure than an exception taking the whole route down.
  const turnsToday = pulse.data?.totals?.turns ?? 0;

  const me = useMe();
  // Without the cron plugin there is no schedule to read: asking anyway earns a 503 and would render an
  // empty pod that reads as "nothing scheduled" rather than "this instance has no scheduler".
  const cron = usePluginPresent('cronjob');
  // The month figure is core usage and stays regardless; only its link belongs to the plugin's page.
  const stats = usePluginPresent('stats');
  const jobs = useCronJobs(cron && (me.data?.user?.is_admin ?? false));
  const next = useMemo(() => {
    let best: { at: number; name: string } | null = null;
    for (const job of jobs.data ?? []) {
      const at = nextCronRun(job, now);
      if (at != null && (!best || at < best.at)) best = { at, name: job.name };
    }
    return best;
  }, [jobs.data, now]);

  const monthBounds = useMemo(() => currentMonthBounds(now), [now]);
  const monthly = useModelUsage(monthBounds);
  const daily = useUsageByDay(7);
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
      id: 'people',
      icon: Radio,
      label: t.dashboard.signalWorkingNow,
      value: String(working),
      // Turns rather than a second head-count: with nobody mid-turn the pod would otherwise read
      // "0 · 0" and say nothing about whether the instance was busy at all today.
      detail: working > 0
        ? t.dashboard.workingUnit
        : t.dashboard.pulseTurnsToday.replace('{count}', String(turnsToday)),
      href: '/chat',
    },
    ...(cron ? [{
      id: 'cron' as const,
      icon: AlarmClock,
      label: t.dashboard.nextRunLabel,
      value: next ? new Date(next.at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—',
      detail: next?.name ?? t.dashboard.noCron,
      // The plugin's own page. The previous target, `/settings?section=cron`, matched no parameter the
      // Settings page reads (`?cat=`) and no section id it has, so the pod opened plain Settings.
      href: '/p/cronjob/settings/jobs',
    }] : []),
    {
      id: 'cost',
      icon: Coins,
      label: t.dashboard.signalMonthCost,
      value: summary.totalCostLabel,
      detail: `${t.dashboard.last7d} · ${t.dashboard.today.replace('{cost}', todayLabel)}`,
      // The value is core usage and stays either way; only the link belongs to the plugin's page.
      href: stats ? '/p/stats' : undefined,
    },
  ];

  useEffect(() => {
    const root = rootRef.current;
    const svg = svgRef.current;
    const podsLayer = podsRef.current;
    if (!root || !svg || !podsLayer) return;
    // The flat mode has no geometry to compute: no core to orbit, no filaments to draw, and pods that
    // CSS lays out. Returning before the observer is even attached is what leaves the DOM clean enough
    // for a stylesheet to own the arrangement — the orbit path writes inline `left`/`top` onto every
    // pod, and inline styles are not something a design can override.
    //
    // It has to CLEAR that geometry first, not merely stop producing it. Switching skin does not remount
    // this subtree — Shell.tsx keeps one mount across a skin change so a live conversation survives it —
    // so arriving here from Ember's orbit means every pod still carries the `left`/`top` the last layout
    // pass wrote. The grid rule sets `position: relative`, at which point those absolute coordinates
    // become real offsets and the cards land off the page until a reload.
    if (flat) {
      root.dataset.mode = 'grid';
      svg.replaceChildren();
      for (const pod of podsLayer.querySelectorAll<HTMLElement>(':scope > .hero-cosmos__pod')) {
        pod.style.left = '';
        pod.style.top = '';
        pod.style.removeProperty('--fx');
        pod.style.removeProperty('--fy');
      }
      return;
    }

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
      const angles = podEls.length < 4 ? { ...ANGLES_DEG, ...REDUCED_ANGLES_DEG } : ANGLES_DEG;
      for (const pod of podEls) {
        const id = pod.dataset.pod as PodId;
        const angle = (angles[id] * Math.PI) / 180;
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
          ...(alertRef.current && id === 'people' ? { extraClass: 'hero-fil--alert' } : {}),
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
    // Re-run when the pod SET changes (a pod appears once /plugins/ui confirms its plugin):
    // the ResizeObserver only fires on size changes, so a DOM-only pod addition would otherwise keep
    // stale orbit positions.
  }, [cron, stats, flat]);

  // The waiting state re-tones the people filament amber to match the presence aura. The layout
  // pass re-applies it via alertRef because a redraw recreates the paths.
  useEffect(() => {
    alertRef.current = state === 'needs_input';
    const svg = svgRef.current;
    if (!svg) return;
    for (const path of svg.querySelectorAll('path')) {
      path.classList.toggle('hero-fil--alert', alertRef.current && path.dataset.pod === 'people');
    }
  }, [state]);

  return (
    <div ref={rootRef} className="hero-cosmos" data-mode={flat ? 'grid' : 'stack'} data-testid="hero-cosmos">
      <svg ref={svgRef} className="hero-cosmos__filaments" aria-hidden="true" />
      <div className="hero-cosmos__core">
        <ElowenPresence state={state} label={presenceLabel} />
      </div>
      <nav ref={podsRef} className="hero-cosmos__pods" aria-label={t.dashboard.attention}>
        {pods.map((pod) => {
          // A pod whose destination belongs to a disabled plugin keeps its reading and loses only the
          // link: the same orb in the same orbit, not a hole in the layout and not a dead click.
          const className = `hero-cosmos__pod${pod.alert ? ' hero-cosmos__pod--alert' : ''}`;
          const body = (
            <>
              <span className="hero-cosmos__orb"><pod.icon size={14} aria-hidden /></span>
              <span className="hero-cosmos__body">
                <span className="hero-cosmos__label">{pod.label}</span>
                <span className="hero-cosmos__value">{pod.value}</span>
                <span className="hero-cosmos__detail">{pod.detail}</span>
                {pod.id === 'cost' ? <Sparkline days={days} /> : null}
              </span>
            </>
          );
          return pod.href
            ? <Link key={pod.id} href={pod.href} data-pod={pod.id} className={className}>{body}</Link>
            : <span key={pod.id} data-pod={pod.id} className={className}>{body}</span>;
        })}
      </nav>
    </div>
  );
}

/** Seven-day token sparkline carried over from the retired attention rail. Today is the accented
 *  column, because it is the day the figure beside it reports. */
function Sparkline({ days }: { days: { day: string; tokens: number }[] }) {
  return (
    <SharedSparkline
      values={days.map((day) => day.tokens)}
      colour="var(--color-primary)"
      variant="bar"
      highlightLast
      className="mt-1.5 h-5 w-full"
    />
  );
}
