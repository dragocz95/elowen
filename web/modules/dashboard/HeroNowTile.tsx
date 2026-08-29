'use client';
import { useTranslation } from '../../lib/i18n';
import { useBrand } from '../../lib/brand';
import { HeroCosmos } from './HeroCosmos';
import { HomeComposer } from './HomeComposer';
import type { Presence, PresenceState } from './usePresence';

/** The box you type into, beside the being — the whole of what this tile is.
 *
 *  The greeting, the status line and the clock that used to open it live in the page's WorkspaceHero
 *  (DashboardView): they are the page's title block, and having a second <h1> inside the first surface
 *  below it meant the dashboard announced itself twice.
 *
 *  A status ROW used to sit above the composer as well — the live conversation as a link while somebody
 *  was mid-turn, a "resting" card otherwise. It is gone rather than restyled, because the page already
 *  answers that question three times below the fold: the live tile counts who is working, the pulse draws
 *  the same flag, and the activity feed names the person in its own header. An unreachable daemon is the
 *  one fact none of them can report, and it belongs to the whole page, so it is the hero's description.
 *  The presence state still reaches the orbital field, which is what actually renders it. */
export function HeroNowTile({ now, presence }: { now: number; presence: Presence }) {
  const { t } = useTranslation();
  const { appName } = useBrand();

  const stateLabel = stateText(t.dashboard.presence, presence.state);

  return (
    <section className="hero-now relative isolate overflow-hidden px-1 py-5 @container @sm:px-3 @sm:py-7">
      {/* The wash itself is declared in dashboard-cosmos.css. It was an inline `style`, which no
          stylesheet can override — a design that does not want an accent gradient behind its dashboard
          had no way to say so. */}
      <div className="dash-aura pointer-events-none absolute inset-0 -z-10" aria-hidden />
      {/* No min-height below the orbit threshold. The grid used to reserve 29rem at every width — a
          figure chosen when the whole app was rendered at ~72% — which on a phone was half a screen of
          nothing above the fold. Room is reserved only where the two-column field is actually drawn. */}
      <div className="hero-now__field grid items-center gap-6 @3xl:min-h-[22rem] @3xl:grid-cols-[minmax(0,1fr)_minmax(20rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <HomeComposer placeholder={t.dashboard.composerPlaceholder} actionLabel={t.dashboard.composerAction.replace('{agentName}', appName)} />
        </div>

        <div className="hero-now__signals flex flex-col justify-center @3xl:min-h-[18rem] @3xl:self-stretch">
          <HeroCosmos now={now} state={presence.state} presenceLabel={`${appName}: ${stateLabel}`} />
        </div>
      </div>
    </section>
  );
}

function stateText(labels: Record<PresenceState, string>, state: PresenceState): string {
  return labels[state];
}
