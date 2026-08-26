import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '../../test-utils';
import type { MemoryVitalityHistory } from '../../../lib/types';

const history = vi.fn();

vi.mock('../../../lib/queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useMemoryVitalityHistory: (id: number | null) => history(id),
}));

import { MemoryVitalityChart, buildSeries } from '../../../modules/memory/MemoryVitalityChart';

const NOW = '2026-08-04T12:00:00.000Z';

const curve = (over: Partial<MemoryVitalityHistory> = {}): MemoryVitalityHistory => ({
  points: [
    { at: '2026-07-20T12:00:00.000Z', vitality: 90 },
    { at: '2026-07-28T12:00:00.000Z', vitality: 74 },
    { at: NOW, vitality: 61 },
  ],
  forecast: [
    { at: NOW, vitality: 61 },
    { at: '2026-08-20T12:00:00.000Z', vitality: 38 },
  ],
  recalls: ['2026-07-28T12:00:00.000Z'],
  floor: 10,
  evictAt: '2026-09-15T12:00:00.000Z',
  historyFrom: '2026-07-20T12:00:00.000Z',
  now: NOW,
  ...over,
});

const loaded = (data: MemoryVitalityHistory) => ({ data, isLoading: false, isError: false });

beforeEach(() => {
  history.mockReset();
  history.mockReturnValue(loaded(curve()));
});

const renderChart = (vitality = 61) =>
  render(<MemoryVitalityChart memoryId={1} vitality={vitality} />, { wrapper: createWrapper().wrapper });

// The series feeding the chart, which is where every decision this component makes actually lives.
// The drawing itself is Recharts' and cannot be asserted here: jsdom reports a zero-sized box, so the
// chart renders nothing at all under test.
describe('buildSeries', () => {
  it('keeps the past and the forecast on one shared time axis, in order', () => {
    const rows = buildSeries(curve());
    expect(rows?.map((row) => row.t)).toEqual([...(rows ?? [])].map((row) => row.t).sort((a, b) => a - b));
    // Measured points carry `past`, projected ones carry `projected` — that split is what draws one
    // line solid and the other dashed.
    expect(rows?.filter((row) => row.past !== undefined)).toHaveLength(3);
    expect(rows?.filter((row) => row.projected !== undefined)).toHaveLength(2);
  });

  it('joins the two lines at the seam instead of leaving a gap', () => {
    // The last measured instant must belong to BOTH series, or the dashed line starts one step to the
    // right of where the solid one ends and the curve reads as broken.
    const seam = buildSeries(curve())?.find((row) => row.t === Date.parse(NOW));
    expect(seam?.past).toBe(61);
    expect(seam?.projected).toBe(61);
  });

  it('seams a forecast that does not repeat the last measured point', () => {
    const rows = buildSeries(curve({
      forecast: [{ at: '2026-08-20T12:00:00.000Z', vitality: 38 }],
    }));
    expect(rows?.find((row) => row.t === Date.parse(NOW))?.projected).toBe(61);
  });

  it('refuses a series too short to be a line', () => {
    expect(buildSeries(curve({ points: [{ at: NOW, vitality: 61 }], forecast: [] }))).toBeNull();
  });

  it('drops timestamps it cannot read rather than plotting them at zero', () => {
    const rows = buildSeries(curve({ points: [{ at: 'not-a-date', vitality: 90 }] }));
    expect(rows?.some((row) => Number.isNaN(row.t))).toBe(false);
  });
});

describe('MemoryVitalityChart', () => {
  it('says when the memory would be binned, in plain sight', async () => {
    renderChart(61);
    // Said once, visibly. The chart carries no label of its own: `role="img"` would make the tooltip
    // — the only place the individual dates and values can be read — invisible to assistive tech, and
    // a hidden copy of this sentence would just make a screen reader repeat what is already on screen.
    // The rendered date follows the active locale, so pin the sentence and the year, not the format.
    await waitFor(() => expect(screen.getByText(/Moves to the trash on .*2026/)).toBeInTheDocument());
  });

  it('states plainly that a pinned memory is never deleted', async () => {
    history.mockReturnValue(loaded(curve({ evictAt: null })));
    renderChart();

    await waitFor(() => expect(screen.getByText('Never deleted automatically')).toBeInTheDocument());
  });

  // A memory used before the log existed cannot have its past reconstructed. Saying so is the point —
  // the alternative is a chart that looks complete while inventing the part it cannot know.
  it('admits when there is no reconstructable history instead of drawing one', async () => {
    history.mockReturnValue(loaded(curve({ points: [], historyFrom: null })));
    renderChart();

    await waitFor(() => expect(screen.getByText(/only the forecast is shown/)).toBeInTheDocument());
    // With nothing measured there is no seam to draw, so the forecast stands alone.
    expect(buildSeries(curve({ points: [], historyFrom: null }))?.every((row) => row.past === undefined)).toBe(true);
  });

  it('stays out of the way when the curve cannot be loaded', () => {
    history.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = renderChart();

    expect(container).toBeEmptyDOMElement();
  });
});
