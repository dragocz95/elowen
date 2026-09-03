'use client';

import * as React from 'react';
import * as RechartsPrimitive from 'recharts';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Chart primitive on recharts (already a dependency), with one deviation from upstream.
 *
 *  Upstream emits its per-series custom properties TWICE — once bare and once under a `.dark` selector —
 *  because stock shadcn switches palettes with a class on <html>. This app switches DESIGNS with
 *  `[data-skin]` and every skin repaints `--color-chart-*` in its own token block, so a series colour
 *  written as `var(--color-chart-2)` already follows the active skin and a second, class-scoped copy
 *  would be a rule that never matches. One block is emitted instead.
 *
 *  A config value must therefore be a TOKEN reference, never a literal — same rule as everywhere else in
 *  the app (`tests/lib/designTokens.test.ts` scans this file too). */

export type ChartConfig = Record<string, {
  label?: React.ReactNode;
  icon?: React.ComponentType;
  color?: string;
}>;

type ChartContextValue = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChart(): ChartContextValue {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error('useChart must be used within a <ChartContainer />');
  return context;
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const coloured = Object.entries(config).filter(([, item]) => item.color);
  if (coloured.length === 0) return null;
  const body = coloured.map(([key, item]) => `  --color-${key}: ${item.color};`).join('\n');
  return <style dangerouslySetInnerHTML={{ __html: `[data-chart=${id}] {\n${body}\n}` }} />;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children'];
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, '')}`;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          'flex justify-center text-xs',
          '[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-layer]:outline-none [&_.recharts-surface]:outline-none',
          '[&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted',
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipEntry = { name?: string | number; value?: string | number; dataKey?: string | number; color?: string };

function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  className,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: React.ReactNode;
  labelFormatter?: (label: React.ReactNode) => React.ReactNode;
  className?: string;
}) {
  const { config } = useChart();
  if (!active || !payload?.length) return null;
  return (
    <div className={cn('grid min-w-32 gap-1.5 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-[var(--shadow-raised)]', className)}>
      <div className="font-medium text-foreground">{labelFormatter ? labelFormatter(label) : label}</div>
      {payload.map((entry, index) => {
        const key = String(entry.dataKey ?? entry.name ?? index);
        const item = config[key];
        return (
          <div key={key} className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: item?.color ?? entry.color }} />
            <span>{item?.label ?? key}</span>
            <span className="ml-auto font-mono font-medium tabular-nums text-foreground">{entry.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export { ChartContainer, ChartStyle, ChartTooltip, ChartTooltipContent, useChart };
