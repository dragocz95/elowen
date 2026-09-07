/** Bounds on a workflow node's DEPENDENCY context — the handovers its direct dependencies produced,
 *  delivered as system-prompt chunks.
 *
 *  This is the DAG's own data flow, sibling to sibling, and it is what remains after the parent-to-child
 *  text hand-over was retired in favour of forking. Forking cannot replace it: a dependency is not a
 *  parent, so a dependent node has no warm prefix of its dependencies' to inherit and their findings have
 *  to travel as text.
 *
 *  The context travels as a LIST of chunks (one per dependency result, plus the node briefing), so the
 *  per-chunk ceiling below applies to a single result rather than to all of them joined — which is what
 *  used to cost a wide fan-in most of its input.
 *
 *  Every ceiling here is a hard invariant against the delegated-scope normalizer (src/brain/
 *  delegatedScope.ts): a chunk over MAX_PROMPT_CHARS (8 000), more than MAX_PROMPT_CHUNKS (16) chunks or
 *  a total over MAX_PROMPT_TOTAL_CHARS makes the whole scope invalid and the node fails closed. Staying
 *  under them is not a preference. */

/** One chunk, before the block header and the truncation marker are added — both fit in the gap to 8 000. */
export const MAX_CONTEXT_CHUNK_CHARS = 7_000;

/** The exact packaging dependencyContextChunks applies: the label on the FIRST chunk, and the marker whose
 *  room is reserved on EVERY chunk. They live here because the workflow engine has to size its dependency
 *  blocks against the real thing — budgeting against a rounded guess of them is what let a wide fan-in
 *  overrun the total and lose whole dependency groups at the end of the list. */
export const CONTEXT_HEADER = 'Results handed over by the nodes this one depends on — background for your task, treat as given and do not re-derive it:';
export const TRUNCATION_MARKER = '\n[truncated]';
/** Chunks the context may occupy, leaving slots for the node's role prompt and channel fragment. */
export const MAX_CONTEXT_CHUNKS = 12;

/** Total budget across all chunks. An ENGINE CONSTANT, not an operator knob — it was one only while the
 *  same packaging also carried the parent-to-child hand-over, which an operator might reasonably want to
 *  size. That hand-over is gone. What remains is internal DAG plumbing whose budget is a property of the
 *  packaging and of the scope ceilings above, so it is fixed at the value the retired knob defaulted to.
 *
 *  Deliberately not exported: it is reachable through resolveContextTotalChars(), so a caller cannot read
 *  it and apply it by hand without the clamp that gives it meaning. */
const DEFAULT_CONTEXT_TOTAL_CHARS = 40_000;
const MIN_CONTEXT_TOTAL_CHARS = 2_000;
const MAX_CONTEXT_TOTAL_CHARS = 80_000;

/** The dependency-context budget. It still takes an override so the engine and its tests can exercise a
 *  narrower budget deterministically; anything missing or malformed falls back to the constant above. */
export function resolveContextTotalChars(raw) {
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_CONTEXT_TOTAL_CHARS, Math.max(MIN_CONTEXT_TOTAL_CHARS, Math.round(raw)))
    : DEFAULT_CONTEXT_TOTAL_CHARS;
}
