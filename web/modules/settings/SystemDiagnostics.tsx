'use client';
import { Cpu, MemoryStick, Timer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer } from 'recharts';
import type { LocaleDict } from '../../lib/i18n/types';

/** The host's CPU, memory and uptime under the System settings.
 *
 *  Two of these three are proportions of a known whole, which is exactly what a dial is for: the empty
 *  part of the arc is as meaningful as the filled part, so "busy" is legible without reading the
 *  number. Uptime is not — it grows without a ceiling, and the bar it used to have was filled to a
 *  hardcoded 72 % regardless of the actual value, which is a picture that cannot be right. It gets the
 *  same frame and the figure alone.
 *
 *  Only the percentage goes inside the ring, because the hole is the one place on the card with a hard
 *  width limit: "22.8 GB / 32.9 GB" is wider than the dial's diameter and spilled across the arc it was
 *  supposed to describe. Anything longer than a percentage sits on the caption line underneath, where
 *  it has the full width of the card and lines up with the captions on either side.
 *
 *  Colour is a threshold, not decoration: past 70 % the dial turns amber and past 90 % red, so the one
 *  reading that needs attention is the one that catches the eye. */

const GAUGE_H = 96;
/** Leaves the ring open at the bottom, so the gap reads as a scale rather than as a missing piece. */
const START_ANGLE = 220;
const END_ANGLE = -40;

function toneFor(percent: number): string {
  if (percent >= 90) return 'var(--color-danger)';
  if (percent >= 70) return 'var(--color-warning)';
  return 'var(--color-primary)';
}

/** One card: a label, a dial or a plain figure, and a caption line. The caption keeps its height even
 *  when empty so the three cards stay the same size and their dials sit on one line. */
function Card({ icon: Icon, label, children, caption }: {
  icon: LucideIcon; label: string; children: React.ReactNode; caption?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl border border-border/60 bg-elevated/25 px-3 py-3">
      <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        <Icon size={12} aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <div className="relative w-full" style={{ height: GAUGE_H }}>{children}</div>
      <span className="h-4 w-full truncate text-center font-mono text-[11px] tabular-nums text-text-muted">
        {caption ?? ''}
      </span>
    </div>
  );
}

/** A dial with its percentage in the hole. */
function Dial({ percent }: { percent: number }) {
  const colour = toneFor(percent);
  return (
    <>
      {/* aria-hidden: the reading is printed in the middle of the dial, and a screen reader should get
       *  that number rather than a description of an arc. */}
      <div aria-hidden className="absolute inset-0">
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            accessibilityLayer={false}
            data={[{ value: percent }]}
            innerRadius="74%"
            outerRadius="100%"
            startAngle={START_ANGLE}
            endAngle={END_ANGLE}
            barSize={7}
          >
            {/* Fixes the scale to 0..100 — without it a single datum fills the whole arc whatever it says. */}
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar
              dataKey="value"
              fill={colour}
              cornerRadius={4}
              isAnimationActive={false}
              background={{ fill: 'var(--color-border)', opacity: 0.35 }}
            />
          </RadialBarChart>
        </ResponsiveContainer>
      </div>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="font-mono text-base leading-none tabular-nums text-text">
          {Math.round(percent)} %
        </span>
      </div>
    </>
  );
}

/** The middle of a card with no dial to put a figure inside. */
function Plain({ value }: { value: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <span className="truncate px-1 font-mono text-base leading-none tabular-nums text-text">{value}</span>
    </div>
  );
}

export function SystemDiagnostics({ diagnostics, t, formatMemory, formatUptime }: {
  diagnostics: { cpuPercent: number; memoryUsedBytes: number; memoryTotalBytes: number; uptimeSeconds: number } | undefined;
  t: LocaleDict;
  formatMemory: (used: number, total: number) => string;
  formatUptime: (seconds: number) => string;
}) {
  const memoryPct = diagnostics?.memoryTotalBytes
    ? (diagnostics.memoryUsedBytes / diagnostics.memoryTotalBytes) * 100
    : null;

  return (
    <div className="grid grid-cols-1 gap-2 @sm:grid-cols-3" aria-busy={!diagnostics}>
      <Card icon={Cpu} label={t.settings.diagnosticCpu}>
        {diagnostics ? <Dial percent={diagnostics.cpuPercent} /> : <Plain value="—" />}
      </Card>

      <Card
        icon={MemoryStick}
        label={t.settings.diagnosticMemory}
        caption={diagnostics ? formatMemory(diagnostics.memoryUsedBytes, diagnostics.memoryTotalBytes) : undefined}
      >
        {memoryPct === null ? <Plain value="—" /> : <Dial percent={memoryPct} />}
      </Card>

      {/* No dial: uptime has no ceiling to be a fraction of. */}
      <Card icon={Timer} label={t.settings.diagnosticUptime}>
        <Plain value={diagnostics ? formatUptime(diagnostics.uptimeSeconds) : '—'} />
      </Card>
    </div>
  );
}
