import { fetchDashRecap } from '../../lib/serverPrefetch';
import { DashPageBody } from './DashPageBody';

/** Per-caller and never cached: the recap below is one account's own day. */
export const dynamic = 'force-dynamic';

/** The workspace home. A server component for ONE reason — it prefetches the caller's recap so the hero
 *  arrives already carrying the agent-written greeting, instead of painting the time-of-day fallback and
 *  swapping it out once the client's own fetch resolves. A null seed (logged out, daemon down) renders
 *  exactly as it did before and the client query fills it in. */
export default async function DashPage() {
  const recapSeed = await fetchDashRecap();
  return <DashPageBody recapSeed={recapSeed} />;
}
