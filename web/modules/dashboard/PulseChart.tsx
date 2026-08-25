'use client';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { colorFor, seriesKey, type PulseChartRow } from './pulseSeries';
import type { LocaleDict } from '../../lib/i18n/types';
import type { PulsePerson } from '../../lib/types';

/** The instance's day, hour by hour: one line per person over a soft area of memory recalls.
 *
 *  Recharts rather than the hand-rolled SVG the rest of the dashboard uses, because this is the one
 *  chart that has to answer "what exactly happened at 16:00" — a shared crosshair, a hit area per hour
 *  and a tooltip that resolves every series at once is a lot of pointer maths to own by hand.
 *
 *  Recalls ride a second, hidden axis on purpose: an active hour pulls a couple of hundred memories
 *  against a handful of turns, so on one shared scale every human curve would flatten to the floor. */

const AXIS = 'var(--color-text-subtle)';
const TICK = { fontSize: 10, fill: AXIS, fontFamily: 'var(--font-mono)' };
/** Every fourth hour, which is what the reference axis reads like and what fits a tile at tablet width. */
const HOUR_TICKS = [0, 4, 8, 12, 16, 20];
const hourLabel = (h: number): string => `${String(h).padStart(2, '0')}:00`;

interface TooltipEntry { dataKey?: string | number; value?: number | string }
interface TooltipShape {
  active?: boolean;
  label?: number | string;
  payload?: TooltipEntry[];
  people?: PulsePerson[];
  t?: LocaleDict;
}

/** The hover card. Reports the whole instance for one hour rather than the nearest single series, so
 *  moving along the axis answers "who was working, and how much" without chasing individual lines. */
function PulseTooltip({ active, label, payload, people = [], t }: TooltipShape) {
  if (!active || !payload?.length || !t) return null;
  const at = (key: string): number => {
    const hit = payload.find((p) => p.dataKey === key);
    return typeof hit?.value === 'number' ? hit.value : 0;
  };
  const memory = at('memory');
  const rows = people
    .map((person, i) => ({ person, i, turns: at(seriesKey(person)) }))
    .filter((r) => r.turns > 0);

  return (
    <div className="rounded-lg border border-border bg-surface/95 px-3 py-2 shadow-lg backdrop-blur">
      <div className="mb-1.5 font-mono text-[11px] tabular-nums text-text">
        {hourLabel(typeof label === 'number' ? label : 0)}
      </div>
      {rows.length === 0 ? (
        <div className="text-[11px] text-text-muted">{t.dashboard.pulseQuietHour}</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ person, i, turns }) => (
            <li key={person.userId} className="flex items-center gap-2 text-[11px]">
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorFor(i) }} />
              <span className="mr-2 max-w-32 truncate text-text">{person.label}</span>
              <span className="ml-auto font-mono tabular-nums text-text">
                {t.dashboard.pulseTurnsUnit.replace('{count}', String(turns))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {memory > 0 ? (
        <div className="mt-1.5 border-t border-border/60 pt-1.5 font-mono text-[10px] tabular-nums text-text-muted">
          {t.dashboard.pulseMemoryUnit.replace('{count}', String(memory))}
        </div>
      ) : null}
    </div>
  );
}

export function PulseChart({ rows, people, t }: { rows: PulseChartRow[]; people: PulsePerson[]; t: LocaleDict }) {
  return (
    <div className="h-56 w-full @md:h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -22 }}>
          <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.4} vertical={false} />
          <XAxis
            dataKey="hour" ticks={HOUR_TICKS} tickFormatter={hourLabel} tick={TICK}
            axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16}
          />
          <YAxis yAxisId="turns" tick={TICK} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
          <YAxis yAxisId="memory" hide />
          <Tooltip
            content={<PulseTooltip people={people} t={t} />}
            cursor={{ stroke: 'var(--color-border-strong)', strokeWidth: 1, strokeDasharray: '3 3' }}
            // Recharts animates the card between hours by default, which reads as lag on a crosshair.
            isAnimationActive={false}
          />
          <defs>
            <linearGradient id="pulse-memory-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.16} />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            yAxisId="memory" dataKey="memory" type="monotone" fill="url(#pulse-memory-fill)"
            stroke="none" isAnimationActive={false} activeDot={false}
          />
          {people.map((person, i) => (
            <Line
              key={person.userId}
              yAxisId="turns"
              dataKey={seriesKey(person)}
              name={person.label}
              type="monotone"
              stroke={colorFor(i)}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
