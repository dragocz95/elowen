/** What a fork ACTUALLY shared, read back off the captured requests rather than inferred from a token
 *  count.
 *
 *  The fork cache line reports a verdict from usage numbers: how much the child read back against how big
 *  the parent's warm prefix was. That answers whether sharing happened, never where it stopped — and
 *  `prefix mismatch` is the one verdict a reader cannot act on without knowing which segment diverged. The
 *  request recorder already stores every request as digested segments (system, tools, one per message), so
 *  the answer is a comparison of two stored manifests: the parent's last request before the fork, and the
 *  child's first.
 *
 *  Pure and dependency-free on purpose. It is the same comparison behind the fork log line and behind the
 *  post-deploy self-check, so the two can never disagree about where a prefix broke; and being pure, it can
 *  be pointed at fixture rows in a test without a daemon, a provider or a live session. */

/** One captured request segment, as the request store's manifest describes it. Structural rather than
 *  imported: the store's DTO satisfies this, and nothing here needs the rest of that type. */
export interface ForkPrefixSegment {
  section: string;
  kind: string;
  digest: string;
  role?: string;
  label?: string;
  preview?: string;
}

/** The sections that make up the hashed prefix, in the order a provider hashes them. `options` is
 *  deliberately absent: top-level request options sit outside the cached prefix, so a difference there is
 *  not why a fork missed the cache. */
const PREFIX_SECTIONS = ['system', 'tool', 'input'] as const;
export type ForkPrefixSection = typeof PREFIX_SECTIONS[number];

export interface ForkPrefixDifference {
  section: ForkPrefixSection;
  /** Position WITHIN that section, which is how a reader finds it in the request viewer. */
  index: number;
  /** `changed`: both sides have a segment here and they differ. `missing`: the child does not carry a
   *  segment the parent had. `extra`: the child carries one the parent did not, in a section where that
   *  alone breaks the prefix (its own trailing messages are expected and never counted here). */
  reason: 'changed' | 'missing' | 'extra';
  parent?: ForkPrefixSegment;
  child?: ForkPrefixSegment;
}

export interface ForkPrefixComparison {
  /** True when the child's request opens with the whole of the parent's hashed prefix. */
  shared: boolean;
  /** How many segments were compared before the verdict was reached. */
  compared: number;
  difference?: ForkPrefixDifference;
  counts: Record<ForkPrefixSection, { parent: number; child: number }>;
}

function sectionOf(segments: readonly ForkPrefixSegment[], section: ForkPrefixSection): ForkPrefixSegment[] {
  return segments.filter((segment) => segment.section === section);
}

/** Where the child's request stops being its parent's.
 *
 *  A child legitimately carries MORE messages than its parent's last request — the stand-in results for the
 *  parent's open tool calls and its own directive ride behind the inherited tail — so extra `input`
 *  segments are expected. Extra system or tool segments are not: those sit in front of every message, so
 *  one of them alone re-bills the whole conversation. */
export function compareForkPrefix(
  parentSegments: readonly ForkPrefixSegment[],
  childSegments: readonly ForkPrefixSegment[],
): ForkPrefixComparison {
  const counts = {} as ForkPrefixComparison['counts'];
  let compared = 0;
  let difference: ForkPrefixDifference | undefined;
  for (const section of PREFIX_SECTIONS) {
    const parent = sectionOf(parentSegments, section);
    const child = sectionOf(childSegments, section);
    counts[section] = { parent: parent.length, child: child.length };
    if (difference) continue; // keep counting so the report can still describe both requests
    const shared = Math.min(parent.length, child.length);
    for (let index = 0; index < shared; index += 1) {
      compared += 1;
      const left = parent[index]!;
      const right = child[index]!;
      if (left.digest === right.digest && left.kind === right.kind) continue;
      difference = { section, index, reason: 'changed', parent: left, child: right };
      break;
    }
    if (difference) continue;
    if (child.length < parent.length) {
      difference = { section, index: shared, reason: 'missing', parent: parent[shared]! };
    } else if (child.length > parent.length && section !== 'input') {
      difference = { section, index: shared, reason: 'extra', child: child[shared]! };
    }
  }
  return { shared: !difference, compared, ...(difference ? { difference } : {}), counts };
}

/** The difference in one short phrase, for the fork log line: the section, the position, and enough of the
 *  segment itself to recognise it in the request viewer. */
export function describeForkPrefixDifference(difference: ForkPrefixDifference): string {
  const segment = difference.parent ?? difference.child;
  const name = segment?.role || segment?.label || segment?.kind || '';
  return `${difference.section}#${difference.index} ${difference.reason}${name ? ` (${name})` : ''}`;
}

/** The captured requests of one session, oldest first, as the request store hands them over. */
export interface ForkPrefixRequest {
  requestId: string;
  seq: number;
  kind: string;
  status: string;
  startedAt: number;
}

/** The read side the comparison needs — satisfied by `BrainStore.providerRequests`, and by a test fixture
 *  holding two rows. Read-only by construction: nothing here can write.
 *
 *  `sessionCreatedAt` is the anchor: when the child's session row was written, which is the moment of the
 *  fork. Optional so a source that cannot answer it (a fixture, a store older than the column) still gets
 *  a reading through the fallback below rather than none at all. */
export interface ForkPrefixRequestSource {
  rows(sessionId: string): Record<string, unknown>[];
  debugRequest(sessionId: string, requestId: string): { segments: ForkPrefixSegment[] } | undefined;
  sessionCreatedAt?(sessionId: string): number | undefined;
}

function requestsOf(source: ForkPrefixRequestSource, sessionId: string): ForkPrefixRequest[] {
  return source.rows(sessionId).map((row) => ({
    requestId: String(row.request_id),
    seq: Number(row.seq),
    kind: String(row.kind),
    status: String(row.status),
    startedAt: Number(row.started_at),
  }));
}

export interface ForkPrefixReading {
  parent: ForkPrefixRequest;
  child: ForkPrefixRequest;
  comparison: ForkPrefixComparison;
}

/** Compare the parent's last chat request BEFORE the fork against the child's first.
 *
 *  "Before the fork" is the moment the CHILD ROW was created, not the moment the child first spoke, and
 *  the difference is what this diagnostic used to get wrong. A background fork hands its spawner a job id
 *  and lets the parent carry on: the parent finishes its turn and sends the next request of its own while
 *  the child is still starting up. That request sits after the fork and before the child's first, so
 *  anchoring on the child's request selects it — and it legitimately carries the parent's NEW turn frames,
 *  which the child was never meant to hold. The reading then reports `not-shared` for a fork the token
 *  counters show sharing perfectly.
 *
 *  The seed is taken at the moment of the fork, so the request the child's prefix must match is the last
 *  one the parent sent no later than that. `created_at` is stored to the second, so a parent request
 *  inside the same second as the spawn falls on the safe side of the comparison: excluded rather than
 *  wrongly admitted.
 *
 *  The old rule remains as the FALLBACK, for a source that cannot date the child (a fixture, an older
 *  store) and for a parent whose requests before the fork are no longer captured — a reading anchored a
 *  little late still names a segment, where no reading at all names nothing.
 *
 *  Returns undefined when either side captured nothing: request capture has a kill switch, and a missing
 *  record is not evidence of a broken prefix. */
export function forkPrefixReading(
  source: ForkPrefixRequestSource,
  parentSessionId: string,
  childSessionId: string,
): ForkPrefixReading | undefined {
  const child = requestsOf(source, childSessionId).find((request) => request.kind === 'chat');
  if (!child) return undefined;
  const parentRequests = requestsOf(source, parentSessionId).filter((request) => request.kind === 'chat');
  const forkedAt = source.sessionCreatedAt?.(childSessionId);
  const upTo = (limit: number): ForkPrefixRequest | undefined =>
    parentRequests.filter((request) => request.startedAt <= limit).at(-1);
  const parent = (forkedAt === undefined ? undefined : upTo(forkedAt)) ?? upTo(child.startedAt);
  if (!parent) return undefined;
  const parentDetail = source.debugRequest(parentSessionId, parent.requestId);
  const childDetail = source.debugRequest(childSessionId, child.requestId);
  if (!parentDetail || !childDetail) return undefined;
  return { parent, child, comparison: compareForkPrefix(parentDetail.segments, childDetail.segments) };
}

/** The one phrase the fork log line adds, or nothing.
 *
 *  Asked only for a verdict the counters blame on the PREFIX: a different model, a provider without a
 *  cache and a failed first request all state their cause in the reason already, and a segment comparison
 *  would answer a question nobody asked. Never throws — a diagnostic must not be able to cost the line it
 *  decorates, so a missing capture (the recorder has a kill switch) or a failing read simply says nothing.
 *
 *  Takes the verdict rather than computing it, which keeps this module free of the cache-accounting rules
 *  and lets both callers pass the verdict they are already holding. */
export function forkPrefixFirstDifference(
  source: ForkPrefixRequestSource,
  sessions: { parentSessionId: string; childSessionId: string },
  verdict: { shared: boolean; reason: string },
): { firstDifference?: string } {
  if (verdict.shared || (verdict.reason !== 'prefix mismatch' && verdict.reason !== 'prefix rewritten')) return {};
  try {
    const difference = forkPrefixReading(source, sessions.parentSessionId, sessions.childSessionId)?.comparison.difference;
    return difference ? { firstDifference: describeForkPrefixDifference(difference) } : {};
  } catch { return {}; }
}

/** The whole verdict as a person reads it — what the post-deploy self-check prints. */
export function formatForkPrefixReading(
  reading: ForkPrefixReading,
  parentSessionId: string,
  childSessionId: string,
): string {
  const { comparison } = reading;
  const lines = [
    `parent ${parentSessionId} request ${reading.parent.requestId} (seq ${reading.parent.seq}, ${reading.parent.status})`,
    `child  ${childSessionId} request ${reading.child.requestId} (seq ${reading.child.seq}, ${reading.child.status})`,
  ];
  for (const section of PREFIX_SECTIONS) {
    const count = comparison.counts[section];
    lines.push(`  ${section}: parent ${count.parent} segment(s), child ${count.child}`);
  }
  lines.push(comparison.shared
    ? `verdict=shared (${comparison.compared} segment(s) identical, the child opens with its parent's whole prefix)`
    : `verdict=not-shared (first difference at ${describeForkPrefixDifference(comparison.difference!)})`);
  if (comparison.difference) {
    const { parent, child } = comparison.difference;
    if (parent) lines.push(`  parent: ${parent.kind} ${parent.digest.slice(0, 12)} ${parent.preview ?? ''}`.trimEnd());
    if (child) lines.push(`  child:  ${child.kind} ${child.digest.slice(0, 12)} ${child.preview ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}
