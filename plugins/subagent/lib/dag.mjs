// Pure DAG helpers for the workflow engine — no I/O, no agent spawning, so the scheduling rules
// (validation, cycle detection, readiness) are unit-testable in isolation. A workflow node is the
// declarative unit the delegating agent authors: an id, a self-contained task, its dependency ids,
// and the optional per-node model / toolset the child runs with.

const MAX_NODES = 64;
const MAX_TASK_CHARS = 4_000;
const MAX_ID_CHARS = 64;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Detect whether the dependency graph over `nodes` (each `{ id, deps }`) contains a cycle, using an
 *  iterative DFS with a visiting/visited coloring. Unknown deps are ignored here — validation rejects
 *  those separately, so this stays a pure reachability check over the ids that exist. */
function hasCycle(nodes) {
  const deps = new Map(nodes.map((n) => [n.id, n.deps.filter((d) => nodes.some((m) => m.id === d))]));
  const state = new Map(); // id -> 1 visiting, 2 done
  const walk = (id) => {
    state.set(id, 1);
    for (const dep of deps.get(id) ?? []) {
      const s = state.get(dep);
      if (s === 1) return true;        // back-edge into the current DFS path → cycle
      if (s === undefined && walk(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const n of nodes) if (state.get(n.id) === undefined && walk(n.id)) return true;
  return false;
}

/** Normalize one raw node into `{ id, task, deps, model?, tools?, readOnly? }`, or return an error
 *  string. `knownIds` is the full set of ids in the (combined) graph so deps can be checked eagerly. */
function normalizeNode(raw, knownIds) {
  if (!raw || typeof raw !== 'object') return { error: 'each node must be an object' };
  const id = str(raw.id);
  if (!id) return { error: 'each node needs a non-empty string id' };
  if (id.length > MAX_ID_CHARS) return { error: `node id "${id.slice(0, 16)}…" is too long` };
  const task = str(raw.task);
  if (!task) return { error: `node "${id}" needs a non-empty task` };
  const depsRaw = raw.deps === undefined ? [] : raw.deps;
  if (!Array.isArray(depsRaw)) return { error: `node "${id}" deps must be an array of node ids` };
  const deps = [...new Set(depsRaw.map(str).filter(Boolean))];
  for (const dep of deps) {
    if (dep === id) return { error: `node "${id}" cannot depend on itself` };
    if (!knownIds.has(dep)) return { error: `node "${id}" depends on unknown node "${dep}"` };
  }
  const node = { id, task: task.slice(0, MAX_TASK_CHARS), deps };
  const model = str(raw.model);
  if (model) node.model = model;
  if (Array.isArray(raw.tools)) {
    const tools = [...new Set(raw.tools.map(str).filter(Boolean))];
    // An explicitly EMPTY list is a mistake, not "give it everything" — reject it exactly like `delegate`
    // does, rather than silently letting the node inherit the parent's full toolset.
    if (tools.length === 0) return { error: `node "${id}" got an empty tools list — name the tools it should have, or omit the field to inherit yours` };
    node.tools = tools;
  }
  if (raw.read_only === true || raw.readOnly === true) node.readOnly = true;
  return { node };
}

/** Validate + normalize a fresh node list for `workflow_start`. Enforces: non-empty, bounded size,
 *  unique ids, known deps, no self-loop, and an acyclic graph. Returns `{ nodes }` or `{ error }`. */
export function validateWorkflowNodes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'a workflow needs at least one node' };
  if (raw.length > MAX_NODES) return { error: `too many nodes (max ${MAX_NODES})` };
  const ids = raw.map((n) => str(n && n.id)).filter(Boolean);
  const knownIds = new Set(ids);
  const seen = new Set();
  const nodes = [];
  for (const rawNode of raw) {
    const { node, error } = normalizeNode(rawNode, knownIds);
    if (error) return { error };
    if (seen.has(node.id)) return { error: `duplicate node id "${node.id}"` };
    seen.add(node.id);
    nodes.push(node);
  }
  if (hasCycle(nodes)) return { error: 'the workflow has a dependency cycle' };
  return { nodes };
}

/** Validate `raw` new nodes against an already-running workflow (`existing`). New ids must not collide
 *  with existing ones, deps may reference either set, and the COMBINED graph must stay acyclic. Returns
 *  just the normalized NEW nodes (`{ nodes }`) or `{ error }`. */
export function mergeWorkflowNodes(existing, raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'name at least one node to add' };
  if (existing.length + raw.length > MAX_NODES) return { error: `too many nodes (max ${MAX_NODES})` };
  const existingIds = new Set(existing.map((n) => n.id));
  const newIds = raw.map((n) => str(n && n.id)).filter(Boolean);
  const knownIds = new Set([...existingIds, ...newIds]);
  const seen = new Set();
  const added = [];
  for (const rawNode of raw) {
    const { node, error } = normalizeNode(rawNode, knownIds);
    if (error) return { error };
    if (existingIds.has(node.id)) return { error: `node id "${node.id}" already exists in the workflow` };
    if (seen.has(node.id)) return { error: `duplicate node id "${node.id}"` };
    seen.add(node.id);
    added.push(node);
  }
  if (hasCycle([...existing, ...added])) return { error: 'adding those nodes would create a dependency cycle' };
  return { nodes: added };
}

/** The ids of PENDING nodes whose every dependency is `done` — the set the scheduler may launch now.
 *  A node with any dependency that is not yet done (running, pending, or errored) stays blocked, so an
 *  errored dependency permanently blocks its dependents (reported, never silently run). */
export function readyNodeIds(nodes, statusById) {
  return nodes
    .filter((n) => (statusById[n.id] ?? 'pending') === 'pending')
    .filter((n) => n.deps.every((dep) => statusById[dep] === 'done'))
    .map((n) => n.id);
}
