'use client';
/** The Project register's plugin seam: what a plugin may say about a row it owns nothing of.
 *
 *  A project row is core's. What RUNS a managed project is not: the environment behind it belongs to the
 *  sandbox plugin, together with its states, its lifecycle actions and the durable operations they
 *  produce. So the register asks rather than knows. A plugin whose manifest declares `web.projectRows`
 *  registers a hook in its bundle; the register calls it ONCE with the rows on screen and receives a
 *  status per project, actions per project, and one overlay the plugin renders for itself (its progress
 *  window, its confirmations).
 *
 *  The status is deliberately generic — a label, a lucide icon name, a tone, a `busy` flag — so core maps
 *  presentation and the plugin owns meaning. Core never learns the word "running".
 *
 *  Contract for a contributing bundle: `onSelect` handlers must stay callable across renders (a stable
 *  callback, or one that reads its data from a ref). The host holds the frame the plugin last published,
 *  which is at most one render behind the bundle's own state. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PluginUiListing, Project } from './types';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from './pluginUi';
import { usePluginUi } from './queries';
import { useTranslation } from './i18n';
import { PluginErrorBoundary } from '../components/plugin/PluginUiGuards';

export type PluginProjectRowTone = 'muted' | 'accent' | 'success' | 'warning' | 'danger';

/** What a plugin says about ONE project row, at the row's far end, beside the row actions. */
export interface PluginProjectRowStatus {
  /** The state in the reader's language — the tooltip and the accessible name of the icon. */
  label: string;
  /** Lucide icon name, resolved by the host (`pluginLucideIcon`). */
  icon?: string;
  tone?: PluginProjectRowTone;
  /** Something is happening right now: the host draws its own spinner instead of the icon. */
  busy?: boolean;
}

/** What one measured resource IS. Read as a closed set, because each member draws differently:
 *
 *  - `ready` is a measurement against a real ceiling, and only it carries `percent`. It is the only
 *    state a meter may be drawn for.
 *  - `absolute` is an equally real measurement with NO configured ceiling to divide by — a managed
 *    environment has no disk quota, so its disk figure is a true number of bytes and nothing else.
 *    It reads as the figure alone. It used to be reported as `1.2 GiB / ?`, which put a denominator
 *    on screen that does not exist, and as a percentage it would have had to be invented outright.
 *  - `unknown` is a resource nothing is known about YET — the first render of a register, a sample the
 *    runtime is still taking, a machine that is booting. `stopped` is a resource that is not running to
 *    be measured, and `unavailable` is a measurement that could not be taken. None of the three carries
 *    a figure, and none of them is zero: the host draws the ring and leaves it empty, which is why the
 *    strip is on screen in its final geometry before the first batch has answered. */
type PluginProjectRowMetricState = 'ready' | 'absolute' | 'unknown' | 'stopped' | 'unavailable';

export interface PluginProjectRowMetric {
  id: string;
  label: string;
  /** The compact reading: `42%`, `1.2 GiB / 4 GiB`, `1.2 GiB`, or the plugin's word for a state that
   *  has no figure. */
  value: string;
  /** The full sentence, for the tooltip and the meter's `aria-valuetext`. */
  valueText?: string;
  /** A compact secondary identity shown beneath the metric when it adds information, such as a CPU model. */
  description?: string;
  /** Present only on `ready`. A percentage on anything else is a fabricated denominator. */
  percent?: number;
  state: PluginProjectRowMetricState;
}

/** ONE resource snapshot of ONE project in the register.
 *
 *  `refreshing` and `stale` describe what is happening AROUND the figures; the figures themselves stay the
 *  last ones actually measured, in every state. */
export interface PluginProjectRowMetrics {
  label: string;
  items: PluginProjectRowMetric[];
  /** A revalidation is in flight over figures that are still the last known ones. The host indicates it
   *  quietly and keeps every value on screen. */
  refreshing?: boolean;
  /** The last read failed and these figures are older than the plugin would like. They are still real
   *  measurements, so they stay — marked, never replaced with zeros. */
  stale?: boolean;
  /** Names the stale mark, in the plugin's own vocabulary. */
  staleLabel?: string;
}

/** One plugin-owned entry of a project row's action menu. */
interface PluginProjectRowAction {
  /** Stable within the plugin; the host keys the menu entry by `<plugin>:<id>`. */
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  tone?: 'danger';
  onSelect: () => void;
}

interface PluginProjectRowContribution {
  /** Keyed by project id. A project the plugin has nothing to say about is simply absent. */
  status?: Record<number, PluginProjectRowStatus>;
  metrics?: Record<number, PluginProjectRowMetrics>;
  actions?: Record<number, PluginProjectRowAction[]>;
  /** Rendered by the host once, outside the rows: dialogs the plugin's own actions raise. */
  overlay?: ReactNode;
}

type PluginProjectRowsHook = (input: { projects: Project[] }) => PluginProjectRowContribution;

/** What a registration has to actually BE for this seam, which is a plugin's word rather than a type: the
 *  field is read from a foreign bundle, so it is tested instead of asserted. Anything else contributes
 *  nothing, exactly as a bundle that never registered a hook does. */
function projectRowsHookOf(registration: unknown): PluginProjectRowsHook | null {
  const hook = (registration as { projectRows?: unknown } | null | undefined)?.projectRows;
  return typeof hook === 'function' ? hook as PluginProjectRowsHook : null;
}

export interface PluginProjectRows {
  /** The ONE state this row is in, as the register draws it: a row is one project doing one thing, and its
   *  status track holds a single glyph. The first contributing bundle that has something to say about this
   *  project says it — actions merge across bundles, states deliberately do not. */
  statusFor(projectId: number): PluginProjectRowStatus | undefined;
  metricsFor(projectId: number): PluginProjectRowMetrics | undefined;
  actionsFor(projectId: number): (PluginProjectRowAction & { plugin: string })[];
  /** Mount this inside the register: the contributing bundles run here, and their overlays render here. */
  hosts: ReactNode;
}

const EMPTY: (PluginProjectRowAction & { plugin: string })[] = [];

/** What the host must re-render for. Closures are excluded on purpose: their identity changes on every
 *  bundle render and none of it is visible, while a label, an icon, a tone or a disabled flag is. */
function signatureOf(contributions: Map<string, PluginProjectRowContribution>): string {
  return JSON.stringify([...contributions].map(([plugin, contribution]) => [
    plugin,
    contribution.status ?? {},
    contribution.metrics ?? {},
    Object.fromEntries(Object.entries(contribution.actions ?? {}).map(([id, actions]) => [
      id,
      actions.map((action) => [action.id, action.label, action.icon ?? '', action.tone ?? '', action.disabled === true]),
    ])),
  ]));
}

export function usePluginProjectRows(projects: Project[]): PluginProjectRows {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  const entries = useMemo(
    () => (listing.data ?? []).filter((entry) => entry.projectRows === true && entry.apiVersion <= PLUGIN_UI_API_VERSION),
    [listing.data],
  );
  // The published frames live in a ref and the host re-renders on their SIGNATURE. A contributing bundle
  // renders as a child, i.e. after this component, so a frame that changes what the row shows lands one
  // render later — which is what the signature state is for, and why a plain state write per render (with
  // a fresh object every time) would be an endless loop instead.
  const frames = useRef(new Map<string, PluginProjectRowContribution>());
  const [, setSignature] = useState('');
  const publish = useCallback((plugin: string, contribution: PluginProjectRowContribution) => {
    frames.current.set(plugin, contribution);
  }, []);
  // Called from the bundle's own effect, i.e. after the commit — a setState during another component's
  // render is the one thing this seam must not do.
  const settle = useCallback(() => {
    const next = signatureOf(frames.current);
    setSignature((current) => (current === next ? current : next));
  }, []);
  const forget = useCallback((plugin: string) => {
    frames.current.delete(plugin);
    setSignature(signatureOf(frames.current));
  }, []);

  return {
    statusFor: (projectId) => {
      for (const contribution of frames.current.values()) {
        const status = contribution.status?.[projectId];
        if (status) return status;
      }
      return undefined;
    },
    metricsFor: (projectId) => {
      for (const contribution of frames.current.values()) {
        const metrics = contribution.metrics?.[projectId];
        if (metrics) return metrics;
      }
      return undefined;
    },
    actionsFor: (projectId) => {
      const actions: (PluginProjectRowAction & { plugin: string })[] = [];
      for (const [plugin, contribution] of frames.current) {
        for (const action of contribution.actions?.[projectId] ?? []) actions.push({ ...action, plugin });
      }
      return actions.length > 0 ? actions : EMPTY;
    },
    hosts: entries.map((entry) => (
      <PluginProjectRowsHost key={entry.name} entry={entry} projects={projects} onPublish={publish} onSettle={settle} onGone={forget} />
    )),
  };
}

/** Loads one plugin's bundle and mounts its hook when the bundle actually registered one. A bundle that
 *  fails to load contributes nothing and says nothing: a register row must not grow an error strip
 *  because a plugin's JS is missing — the plugin's own surfaces already report that. A hook that RAN and
 *  threw is a different thing, and is caught by the shared plugin boundary: the failure belongs to the
 *  plugin's slot, and the register around it is core's and still has rows to draw. */
function PluginProjectRowsHost({ entry, projects, onPublish, onSettle, onGone }: {
  entry: PluginUiListing;
  projects: Project[];
  onPublish: (plugin: string, contribution: PluginProjectRowContribution) => void;
  onSettle: () => void;
  onGone: (plugin: string) => void;
}) {
  const { t } = useTranslation();
  const [hook, setHook] = useState<PluginProjectRowsHook | null>(null);
  useEffect(() => {
    let alive = true;
    void loadPluginUi(entry.name, entry.url, entry.cssUrl)
      .then((value) => { if (alive) setHook(() => projectRowsHookOf(value)); });
    return () => { alive = false; };
  }, [entry.cssUrl, entry.name, entry.url]);
  useEffect(() => () => onGone(entry.name), [entry.name, onGone]);

  if (!hook) return null;
  // Mounted only once a hook exists, so the number of hooks this subtree calls never changes under React.
  return (
    <PluginErrorBoundary notice={t.pluginUi.crashed}>
      <PluginProjectRowsRunner plugin={entry.name} hook={hook} projects={projects} onPublish={onPublish} onSettle={onSettle} />
    </PluginErrorBoundary>
  );
}

function PluginProjectRowsRunner({ plugin, hook, projects, onPublish, onSettle }: {
  plugin: string;
  hook: PluginProjectRowsHook;
  projects: Project[];
  onPublish: (plugin: string, contribution: PluginProjectRowContribution) => void;
  onSettle: () => void;
}) {
  const contribution = hook({ projects });
  onPublish(plugin, contribution);
  // No dependency list: every frame the bundle renders is offered, and `settle` re-renders the register
  // only when the frame changed something a row displays.
  useEffect(() => { onSettle(); });
  return <>{contribution.overlay ?? null}</>;
}
