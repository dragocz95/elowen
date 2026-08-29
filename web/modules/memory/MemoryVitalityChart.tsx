'use client';
import { useMemo } from 'react';
import { Activity, CalendarDays } from 'lucide-react';
import {
  CartesianGrid, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { MemoryVitalityHistory } from '../../lib/types';
import { useMemoryVitalityHistory } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { parseTs } from '../../lib/format';
import { vitalityTone } from './memoryMeta';
import { TONE_TEXT } from '../../components/ui/tone';
import { CardHead, CardRow, CardShell } from '../../components/ui/ChartCard';
import { LoadingState } from '../../components/ui/states';

/** A memory's vitality over time: the reconstructed past as a solid line, the "if it is never recalled
 *  again" projection as a dashed one, and the threshold at which retention moves it to the trash.
 *
 *  This is the one chart in the app where the time axis is the point. Vitality decays continuously and
 *  every recall pushes it back up, so the only question worth asking of the picture is WHEN something
 *  happened — which a bare curve with no axis and no hover could not answer. The curve itself is
 *  computed daemon-side: the half-life table is server config the browser deliberately never sees. */

/** Height of the plot itself, and the same number as a Tailwind class for the loading placeholders,
 *  which have to reserve the space the drawn chart will take — otherwise opening the detail shoves the
 *  audit feed below it down the page twice, once per placeholder.
 *
 *  Spelled out as a literal rather than interpolated: Tailwind generates utilities by scanning source
 *  text, so a class built from a runtime value simply does not exist in the stylesheet. Change both. */
const CHART_H = 168;
export const VITALITY_CHART_H_CLASS = 'h-[168px]';

/** Every other figure in the app is monospaced and tabular; axis ticks are figures too. */
const AXIS_TICK = { fontSize: 10, fill: 'var(--color-muted-foreground)', fontFamily: 'var(--font-mono)' } as const;

const TONE_STROKE: Record<ReturnType<typeof vitalityTone>, string> = {
  default: 'var(--color-muted-foreground)',
  accent: 'var(--color-primary)',
  muted: 'var(--color-muted-foreground)',
  danger: 'var(--color-destructive)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
};

interface Row {
  t: number;
  past?: number;
  projected?: number;
}

/** History and forecast share one time axis and one row per instant, because two independent series
 *  would let Recharts place them on separate scales the moment their ranges differ.
 *
 *  Exported for its own test: jsdom computes no layout, so Recharts measures a zero-sized box and
 *  renders nothing there. All of the reasoning worth protecting lives in this function; the drawing is
 *  the library's, and it gets checked in a browser. */
export function buildSeries(history: MemoryVitalityHistory): Row[] | null {
  const rows = new Map<number, Row>();
  const put = (iso: string, key: 'past' | 'projected', vitality: number) => {
    const t = parseTs(iso);
    if (t == null) return;
    rows.set(t, { ...rows.get(t), t, [key]: Math.max(0, Math.min(100, vitality)) });
  };

  for (const point of history.points) put(point.at, 'past', point.vitality);
  for (const point of history.forecast) put(point.at, 'projected', point.vitality);

  // The seam: the last measured point also seeds the projection, otherwise the dashed line starts one
  // step to the right of where the solid one ends and the curve reads as broken. Only when the forecast
  // does not already cover that instant — the daemon computes the two halves against different
  // reference points when a memory has no logged recalls, and its projected value wins over ours.
  const lastPast = history.points.at(-1);
  const seamAt = lastPast ? parseTs(lastPast.at) : null;
  if (lastPast && seamAt != null && rows.get(seamAt)?.projected === undefined) {
    put(lastPast.at, 'projected', lastPast.vitality);
  }

  const series = [...rows.values()].sort((a, b) => a.t - b.t);
  return series.length < 2 ? null : series;
}

export function MemoryVitalityChart({ memoryId, vitality }: { memoryId: number; vitality: number }) {
  const { t, locale } = useTranslation();
  const query = useMemoryVitalityHistory(memoryId);
  const history = query.data;
  const series = useMemo(() => (history ? buildSeries(history) : null), [history]);

  const dayLabel = useMemo(
    () => (ms: number) => new Date(ms).toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
    [locale],
  );

  if (query.isLoading) {
    return <LoadingState variant="block" height={VITALITY_CHART_H_CLASS} />;
  }
  // The curve elaborates on a number that is already shown next to it, so a failure here is not worth
  // an error state of its own — the drawer simply carries on without it.
  if (query.isError || !history || !series) return null;

  const stroke = TONE_STROKE[vitalityTone(vitality)];
  const nowMs = parseTs(history.now);
  const recalls = history.recalls
    .map((at) => parseTs(at))
    .filter((ms): ms is number => ms != null);

  const evictLabel = history.evictAt
    ? new Date(history.evictAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  const summary = evictLabel
    ? t.memory.vitalityEvictOn.replace('{date}', evictLabel)
    : t.memory.vitalityNeverEvicted;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t.memory.vitalityChart}</span>
        <span className={`text-[11px] ${history.evictAt ? TONE_TEXT.warning : TONE_TEXT.muted}`}>{summary}</span>
      </div>

      {/* No `role="img"` and no label on the box. `role="img"` makes every child presentational, which
       *  would hide the tooltip — the only place the individual dates and values can be read at all.
       *  A label is not needed either: the vitality figure and the eviction sentence are both already
       *  on screen, one in the metric row above and one in the header right here, so describing the
       *  chart would only make a screen reader say them a third time. Recharts' own keyboard layer
       *  stays on, so the series can be stepped through with the arrow keys. */}
      <div
        className="w-full rounded-md border border-border/70 bg-muted/30 pr-2 pt-2"
        style={{ height: CHART_H }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={series} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.35} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={dayLabel}
              tick={AXIS_TICK}
              stroke="var(--color-border)"
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              width={28}
              tick={AXIS_TICK}
              stroke="var(--color-border)"
              tickLine={false}
            />

            {/* Retention floor: below this the daily sweep moves the memory to the trash. */}
            <ReferenceLine
              y={history.floor}
              stroke="var(--color-destructive)"
              strokeDasharray="2 3"
              strokeOpacity={0.55}
            />
            {/* Where the reconstructed past ends and the projection begins. */}
            {nowMs == null ? null : <ReferenceLine x={nowMs} stroke="var(--color-border-strong)" />}
            {/* One mark per recall, sitting just above the floor of the plot rather than on the curve —
             *  these are events in time, not vitality readings. Lifted clear of the axis line so the
             *  dot is not half-hidden by it. */}
            {recalls.map((ms) => (
              <ReferenceDot
                key={ms}
                x={ms}
                y={3}
                r={2}
                fill="var(--color-primary)"
                stroke="none"
                ifOverflow="hidden"
              />
            ))}

            <Line
              dataKey="past" type="monotone" stroke={stroke} strokeWidth={1.5}
              dot={false} isAnimationActive={false} connectNulls
            />
            <Line
              dataKey="projected" type="monotone" stroke={stroke} strokeWidth={1.5}
              strokeDasharray="3 3" strokeOpacity={0.6}
              dot={false} isAnimationActive={false} connectNulls
            />

            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: 'var(--color-border-strong)', strokeWidth: 1 }}
              wrapperStyle={{ zIndex: 20, outline: 'none' }}
              content={({ active, payload }) => {
                const row = active ? (payload?.[0]?.payload as Row | undefined) : undefined;
                if (!row) return null;
                const projected = row.past === undefined;
                const value = row.past ?? row.projected;
                if (value === undefined) return null;
                return (
                  <CardShell>
                    <CardHead
                      colour={projected ? 'var(--color-border-strong)' : stroke}
                      title={new Date(row.t).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' })}
                    />
                    <div className="mt-2.5 flex flex-col gap-0.5 border-t border-border/60 pt-2">
                      <CardRow icon={Activity} label={t.memory.fieldVitality}>
                        {Math.round(value)} / 100
                      </CardRow>
                      <CardRow icon={CalendarDays} label={t.memory.vitalitySeriesLabel}>
                        {projected ? t.memory.vitalitySeriesForecast : t.memory.vitalitySeriesMeasured}
                      </CardRow>
                    </div>
                  </CardShell>
                );
              }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <span className="text-[11px] text-muted-foreground">
        {history.historyFrom === null ? t.memory.vitalityNoHistory : t.memory.vitalityForecastHint}
      </span>
    </div>
  );
}
