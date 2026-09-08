// Workflow engine: runs a declarative DAG of sub-agents. Each node is spawned through the SAME host
// `run` handler the `delegate` tool uses (System 1 in-process PI sessions — never Orca/overseer), so a
// node inherits the caller's access/model and its usage rolls up to the originating conversation. The
// engine holds the DAG in memory (like delegate's background jobs) and streams the whole snapshot to the
// parent's clients as `workflow` events on every state change. It does NOT emit `subagent` events, so a
// workflow node never doubles up in the flat sub-agent panel.
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { validateWorkflowNodes, mergeWorkflowNodes, readyNodeIds } from './dag.mjs';
import { toolListCovers, toolPolicyAllows } from './toolLists.mjs';
import { foldToolDetail } from './progress.mjs';
import { THINKING_LEVEL_HINT, resolveThinkingLevel } from './thinking.mjs';
import {
  CONTEXT_HEADER,
  MAX_CONTEXT_CHUNK_CHARS,
  MAX_CONTEXT_CHUNKS,
  TRUNCATION_MARKER,
  resolveContextTotalChars,
} from './limits.mjs';
import { clipTail } from './results.mjs';
import { errorText } from './errors.mjs';
import { raceDetach } from './detach.mjs';
import { resolveResultRetentionMs } from './retention.mjs';

const MAX_WORKFLOWS = 16;
const MAX_RESULT_CHARS = 8_000;
// The workflow snapshot re-emits every node on each state change; the UI only previews a node's task, so
// the snapshot carries at most this many chars of it (the full task still drives the child's turn).
const SNAPSHOT_TASK_PREVIEW = 500;
// Same bound for a terminal node's result/error preview: the modal dock shows a line or two, and the
// full MAX_RESULT_CHARS body already reaches the parent through the blocking WorkflowStart return.
const SNAPSHOT_RESULT_PREVIEW = 500;
// How much of a failed node's reason WorkflowStatus prints on its status line. Enough for a provider's error
// body to be recognisable, short enough that a wide DAG stays one screen.
const STATUS_ERROR_PREVIEW = 300;
// Never hand a node a slice too small to carry a finding. A fan-in whose results cannot each reach this
// is REFUSED (see buildNodeAccess): a node reporting conclusions drawn from three words per dependency —
// or, once the forced minimum overran the budget, from dependencies it was never shown — is worse than a
// node that fails and says why.
const DEP_MIN_CHARS = 400;
// The blank line joining two result blocks inside one chunk.
const DEP_BLOCK_SEPARATOR = '\n\n';

// What a node hands its DIRECT dependents: a short handover it writes for them, never its whole result.
// A full result is written for the human reading the workflow summary — a 8k-char report per dependency
// crowds out the dependent's own work and buries the two facts it actually needs. So a node is asked to end
// its final message with a handover section, and only that section travels down the edge.
const MAX_HANDOVER_CHARS = 4_000;

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATION_MARKER}`);
/** A dependency block keeps the END of the result for the same reason the result itself does — the finding is
 *  in the last paragraph — but with the bare marker PREPENDED rather than clipTail's note. It costs exactly
 *  TRUNCATION_MARKER.length, which the per-block budget arithmetic below reserves, and DelegateRead would be
 *  no use to a node anyway: it reads a session's own children, and a sibling node is not one. `depIntro`
 *  already names, to the node, every dependency it is not seeing whole. */
const DEP_TRUNCATION_PREFIX = '[truncated]\n';
const clipDep = (text, limit) => (text.length <= limit ? text : `${DEP_TRUNCATION_PREFIX}${text.slice(-limit)}`);
const depBlockHeading = (id) => `## Handover from node "${id}"\n`;
/** The note introducing the handover blocks: what they are, which were written by the node itself and which
 *  the engine had to derive, and which had to be cut to fit. A node that mistakes a handover for a complete
 *  result reports a partial finding as the whole picture, so the difference is stated rather than implied. */
const depIntro = (derivedIds, truncatedIds) =>
  'Handovers from the nodes this one depends on follow, one block per node. A handover is the short summary '
  + 'that node wrote for its successors — NOT its full result, which is not available in this conversation.'
  + (derivedIds.length
    ? `\n\nThese nodes wrote no handover, so what follows is the plain END of their result: ${derivedIds.join(', ')}.`
    : '')
  + (truncatedIds.length
    ? `\n\nThese were truncated to fit and you are NOT seeing them in full: ${truncatedIds.join(', ')}. `
      + 'Say so in your output rather than treating what you received as complete.'
    : '');

/** The heading a node ends its final message with when it has successors. Matched case-insensitively, with
 *  or without markdown heading marks, bold, a colon or a few trailing words ("## Handover for node x"),
 *  because that is the range of shapes models produce for one instructed heading. */
const HANDOVER_HEADING = new RegExp(
  '^[ \\t]{0,3}(?:'
  // "## Handover", "### Handover for node \"x\"" — a heading marker licenses trailing words.
  + '#{1,6}[ \\t]*(?:\\*\\*)?handover\\b[^\\n]{0,40}?(?:\\*\\*)?'
  // "**Handover:**" — bold does the same job as the marker.
  + '|\\*\\*handover\\b[^\\n]{0,40}?\\*\\*'
  // A bare line, which must then be the word alone: "handover-of:x" in a body is not a heading.
  + '|handover'
  + ')[ \\t]*:?[ \\t]*$',
  'gim',
);
/** A fenced block opener or closer. The instruction quotes the heading verbatim, so a node that shows the
 *  format in an example fence would otherwise hand its dependents that EXAMPLE — the last match wins. */
const FENCE_LINE = /^[ \t]{0,3}(?:```|~~~)/;

/** Character offsets of the fenced regions of a message, so a heading inside one can be ignored. */
const fencedRanges = (text) => {
  const ranges = [];
  let open;
  let offset = 0;
  for (const line of text.split('\n')) {
    if (FENCE_LINE.test(line)) {
      if (open === undefined) open = offset;
      else { ranges.push([open, offset + line.length]); open = undefined; }
    }
    offset += line.length + 1;
  }
  // An unterminated fence swallows the rest of the message, exactly as a renderer would read it.
  if (open !== undefined) ranges.push([open, text.length]);
  return ranges;
};

/** What a finished node hands down its edges: the text after the LAST handover heading in its final message,
 *  or — when it wrote none — the END of its result, which is where a report's conclusion sits. Bounded either
 *  way, and marked `derived` so the dependent is told which of the two it is reading. */
const handoverOf = (reply) => {
  HANDOVER_HEADING.lastIndex = 0;
  const fences = fencedRanges(reply);
  let heading;
  for (let match = HANDOVER_HEADING.exec(reply); match; match = HANDOVER_HEADING.exec(reply)) {
    if (!fences.some(([from, to]) => match.index >= from && match.index < to)) heading = match;
  }
  const explicit = heading ? reply.slice(heading.index + heading[0].length).trim() : '';
  // MAX_HANDOVER_CHARS is a real ceiling on what travels, so both branches pay for their own marker rather
  // than adding to the bound the dependent's budget arithmetic was sized against.
  return explicit
    ? { text: clip(explicit, MAX_HANDOVER_CHARS - TRUNCATION_MARKER.length), derived: false }
    : { text: clipDep(reply.trim(), MAX_HANDOVER_CHARS - DEP_TRUNCATION_PREFIX.length), derived: true };
};

/** The instruction a node with successors gets, so the handover it hands down is one it WROTE rather than a
 *  tail the engine had to cut. Named successors, because "someone downstream" is not something a node can
 *  write for; a node with none is never asked for one. */
const handoverInstruction = (dependentIds) =>
  `The node${dependentIds.length > 1 ? 's' : ''} ${dependentIds.map((id) => `"${id}"`).join(', ')} depend`
  + `${dependentIds.length > 1 ? '' : 's'} on this one and will receive ONLY a short handover from you — not `
  + 'your full result, which they cannot read. So END your final message with a section that starts with the '
  + `heading "## Handover" and says, in at most ${MAX_HANDOVER_CHARS} characters: what you changed or found `
  + 'and where (exact paths, ids, commands), the decisions they must not undo, and what is still open or '
  + 'unverified. Write it for them, not as a summary for the reader of your report. Without that section '
  + 'they receive only the tail of your result, cut wherever it happens to end.';
/** Whether two `ctx.currentAccess()` boundaries are the same one. The host bakes the boundary into a
 *  delegated child's IMMUTABLE persisted scope and lets that child run again only under an exact match, so
 *  a resume that re-captures a narrowed boundary can no longer re-enter the sessions it minted. Both sides
 *  are built by the same host accessor, so a plain structural compare is exact enough; anything it reads as
 *  a change costs only session continuity (see WorkflowResume), while a missed change would fail the node
 *  inside the host with `delegated access unavailable`. */
const sameParentAccess = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Strip runner-persisted prompt metadata and retain only authority a dynamically added node may inherit. */
const delegableAccess = (access) => ({
  admin: access.admin,
  projectIds: [...access.projectIds],
  owner: access.owner,
  ...(access.toolPolicy ? {
    toolPolicy: {
      ...(access.toolPolicy.allow !== undefined ? { allow: [...access.toolPolicy.allow] } : {}),
      ...(access.toolPolicy.deny !== undefined ? { deny: [...access.toolPolicy.deny] } : {}),
    },
  } : {}),
  permissionBoundary: access.permissionBoundary,
  ...(access.readOnly ? { readOnly: true } : {}),
  ...(access.contributionUserId != null ? { contributionUserId: access.contributionUserId } : {}),
  // The ACCOUNT the child acts as, kept beside the narrower contribution owner. Dropping it left a node
  // that adds nodes of its own unable to name the workspace its whole workflow already runs in.
  ...(access.accountUserId != null ? { accountUserId: access.accountUserId } : {}),
  ...(access.workspaceRef ? { workspaceRef: { ...access.workspaceRef } } : {}),
});
// Some models (seen: Qwen max preview) double-escape non-ASCII in tool-call JSON, so the parsed title
// still carries literal backslash-u sequences ("Docs \u2014 write" instead of "Docs — write"). The title
// is pure display, so decoding is always what the model meant; surrogate pairs recombine naturally.
const decodeUnicodeEscapes = (s) =>
  (s.includes('\\u') ? s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const nodeLabel = (raw, index) => {
  const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id.trim() : '';
  return `node ${index + 1}${id ? ` ("${id}")` : ''}`;
};

/** Add file location to node-validation errors without creating a second set of node rules. The DAG
 *  validator remains the only authority that accepts or rejects nodes; this only turns its first failure
 *  into a location and repair instruction the caller can act on in the source file. `index` is that
 *  validator's OWN offending-node index: searching the list for a node that matches the message instead
 *  names the first entry carrying the id, which is the valid twin whenever an id is repeated. */
const actionableNodeError = (rawNodes, error, index) => {
  if (error === 'a workflow needs at least one node') {
    return 'field "nodes" is empty; add at least one node object with required fields "id" and "task"';
  }
  const raw = index === undefined ? undefined : rawNodes[index];
  if (raw !== undefined) {
    if (error === 'each node must be an object') {
      return `${nodeLabel(raw, index)}: must be an object with required fields "id" and "task"; replace this value with a node object`;
    }
    if (error === 'each node needs a non-empty string id') {
      const issue = isRecord(raw) && !hasOwn(raw, 'id')
        ? 'missing required field "id"'
        : 'field "id" must be a non-empty string';
      return `${nodeLabel(raw, index)}: ${issue}; add a unique non-empty string "id" to this node`;
    }
    const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id.trim() : '';
    if (id && error === `node "${id}" needs a non-empty task`) {
      const issue = !hasOwn(raw, 'task')
        ? 'missing required field "task"'
        : 'field "task" must be a non-empty string';
      return `${nodeLabel(raw, index)}: ${issue}; add a complete, non-empty string "task" to this node`;
    }
    if (id && error.startsWith(`node "${id}" `)) {
      return `${nodeLabel(raw, index)}: ${error.slice(`node "${id}" `.length)}; fix this node in the workflow file`;
    }
  }
  return `${error}; fix the workflow definition in the file`;
};

// The node-declaration shape WorkflowAddNodes takes inline. WorkflowStart reads the same shape out of its
// JSON file, where it is validated by validateWorkflowNodes rather than by this schema — one set of rules,
// two ways in.
const NODE_SHAPE = Type.Object({
  id: Type.String({ description: 'Short unique id for this node (referenced by other nodes\' deps).' }),
  task: Type.String({ description: 'The complete, self-contained instruction for this node\'s sub-agent — it cannot see the conversation.' }),
  deps: Type.Optional(Type.Array(Type.String(), { description: 'Ids of nodes that must finish before this one starts. Omit for a root node.' })),
  model: Type.Optional(Type.String({ description: 'Run this node on a DIFFERENT model (value from DelegateModels). Omit to inherit yours.' })),
  thinkingLevel: Type.Optional(Type.String({ minLength: 1, description: THINKING_LEVEL_HINT })),
  fork: Type.Optional(Type.Boolean({ description: 'FORK the conversation this workflow was started from: this node begins with that conversation\'s system prompt, tools and full history, and its task becomes the directive. Fork a node whose work depends on what the origin conversation already knows; leave it off for an independent step. Refused together with tools, read_only, subagent_type or workspaceId, each of which would rewrite the prompt cache the fork exists to reuse.' })),
  read_only: Type.Optional(Type.Boolean({ description: 'Give this node read-only tools and the non-destructive shell clamp (explore/report, no delegation). The clamp denies destructive commands; it does not prevent writing a file through redirection.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Give this node EXACTLY these tools (names from your own toolset). Narrows only.' })),
  subagent_type: Type.Optional(Type.String({ description: 'Run this node as a named sub-agent TYPE (from the delegate tool\'s type list) — it supplies the role prompt and toolset (a read-only type already includes the non-destructive shell clamp). Omit for a generic node.' })),
  workspaceId: Type.Optional(Type.String({ minLength: 1, description: 'Explicit Sandbox workspace for this node. It may only preserve or narrow the effective parent workspace scope.' })),
});

/** Register the workflow tools on the subagent plugin. `getRun` returns the host channel handler once
 *  connected; `helpers` are the delegate primitives reused verbatim so node spawning matches delegation
 *  exactly (same narrowing invariant, same principal check, same context chunking). */
export function registerWorkflow(ctx, getRun, { resolveDelegateTools, principalOf, dependencyContextChunks }) {
  /** id -> workflow. In-memory only (mirrors delegate's `jobs`): a workflow does not survive a daemon
   *  restart, and its node child sessions persist on their own. */
  const workflows = new Map();
  const sameWorkspaceRef = (a, b) => a?.workspaceId === b?.workspaceId && a?.projectId === b?.projectId;
  const resolveWorkspaceRef = (access, requestedWorkspaceId) => {
    const requested = typeof requestedWorkspaceId === 'string' ? requestedWorkspaceId.trim() : '';
    const inherited = access.workspaceRef;
    if (!requested) return inherited ? { ...inherited } : undefined;
    if (inherited && requested !== inherited.workspaceId) {
      throw new Error('a workspace-scoped workflow node cannot switch to a sibling workspace');
    }
    // The HOST's resolver, not a copy of it here. Resolving a workspace needs the Sandbox control, which is
    // restricted to the plugins that own process launch — so the local version this replaces resolved to
    // nothing for every real workflow while a mocked control kept its tests green, and a turn that had just
    // created a workspace was refused it by WorkflowStart. The account and the project ceiling travel in the
    // host-stamped boundary; the sibling-switch rule stays here because it is the workflow's own.
    const resolved = ctx.resolveWorkspaceScope({
      admin: access.admin,
      projectIds: access.projectIds,
      accountUserId: access.accountUserId,
      ...(inherited ? { workspaceRef: inherited } : {}),
    }, requested);
    if (!resolved) throw new Error('workspace not found in the current project scope');
    if (inherited && !sameWorkspaceRef(inherited, resolved)) {
      throw new Error('a workspace-scoped workflow node cannot switch to a sibling workspace');
    }
    return resolved;
  };
  const resolveNodeWorkspaces = (nodes, parentAccess, defaultWorkspaceRef) => nodes.map((node) => {
    const workspaceRef = node.workspaceId
      ? resolveWorkspaceRef(parentAccess, node.workspaceId)
      : defaultWorkspaceRef ?? parentAccess.workspaceRef;
    const { workspaceId: _workspaceId, ...rest } = node;
    return { ...rest, ...(workspaceRef ? { workspaceRef } : {}) };
  });

  // Shared with delegate's background jobs, from one operator knob — see lib/retention.mjs.
  const resultRetentionMs = resolveResultRetentionMs(ctx.config);

  /** Where a workflow definition belongs by default: under elowen's own data dir, not in the user's
   *  repository. A definition is scaffolding for one run — writing it into the project would leave
   *  untracked files behind after every workflow, or worse, get committed.
   *
   *  Named in the tool description rather than derived by the model, because it is the ONLY way it can
   *  learn this path: it is resolved from the daemon's data root, which no prompt otherwise mentions.
   *  That works because the path is per-INSTALL, not per-session, so it is known at registration.
   *
   *  The directory is created here for the same reason plan mode creates its own: Write does not create
   *  parent directories, so naming a path that does not exist would hand the model an ENOENT it has no
   *  tool to fix. A repository path stays perfectly valid — this is the default, not a restriction. */
  const workflowDir = join(ctx.dataDir(), 'workflows');
  try { mkdirSync(workflowDir, { recursive: true }); } catch { /* surfaces on first write instead */ }

  /** Recovery journals: one JSON file per RUNNING workflow, the engine's own restart survival kit. The
   *  durable brain_workflows snapshot cannot drive a resume — its task/result previews are clipped for
   *  display — so everything a resume actually needs (full node tasks and results, channel ids, the
   *  captured access boundary, shared context, the origin principal) lives here, written on structural
   *  transitions only (start, node session, node terminal, expansion, resume) rather than on every tool
   *  tick. Deleted when the workflow reaches a terminal state: a journal on disk at boot IS the marker of
   *  an interrupted run. Best-effort by design — a failed write costs resumability, never the live run. */
  const journalDir = join(workflowDir, 'state');
  try { mkdirSync(journalDir, { recursive: true }); } catch { /* surfaces on first journal write instead */ }
  const journalPath = (workflowId) => join(journalDir, `${workflowId}.json`);
  const writeJournal = (wf) => {
    try {
      writeFileSync(journalPath(wf.id), JSON.stringify({
        v: 2,
        id: wf.id,
        toolCallId: wf.toolCallId,
        ...(wf.title ? { title: wf.title } : {}),
        background: wf.background === true,
        run: wf.run ?? 0,
        originSessionId: wf.originSessionId,
        originPrincipal: wf.originPrincipal,
        parentAccess: wf.parentAccess ?? null,
        parentModel: wf.parentModel ?? null,
        parentCwd: wf.parentCwd ?? null,
        workspaceRef: wf.workspaceRef ?? null,
        nodes: wf.nodes,
        nodeParentAccess: [...wf.nodeParentAccess],
        nodeParentModel: [...wf.nodeParentModel],
        state: [...wf.state],
      }));
    } catch (e) {
      ctx.logger.warn(`workflow ${wf.id}: recovery journal write failed: ${errorText(e)}`);
    }
  };
  const deleteJournal = (workflowId) => {
    try { unlinkSync(journalPath(workflowId)); } catch { /* already gone — the common case for a clean finish */ }
  };

  const freshNodeState = () => ({ status: 'pending', sessionId: '', channelId: '', taskNote: '', tools: 0, detail: undefined, tokens: undefined, seconds: undefined, model: undefined, thinkingLevel: undefined, startedAt: undefined, result: undefined, handover: undefined, error: undefined });

  /** Appended to a node's task when a resume puts it back into the conversation it already worked in. It has
   *  to read sensibly BOTH ways: the child session usually survives (the node reads its own prior work and
   *  carries on), but if it was rolled over or lost the very same text still describes a clean start. That is
   *  why resume never has to prove the session is alive — the instruction degrades on its own. */
  const RESUME_NOTE = 'Note: an earlier attempt at this node was interrupted before it could finish. If this '
    + 'conversation already holds work you did on this task, continue from where you stopped instead of '
    + 'starting over — re-check anything you had not verified. If it holds nothing, just start from the top.';

  /** Appended instead of RESUME_NOTE when a node that HAD already run is relaunched in a FRESH channel,
   *  because the resume could not carry its session across a changed access boundary. It must not point the
   *  node at a conversation it does not have — but the earlier attempt is not gone either: whatever it wrote
   *  is still on disk, and a node that assumes an untouched tree redoes half-applied work blind. The only
   *  trace it can still observe is that disk state, so that is what this sends it to check. */
  const RESTART_NOTE = 'Note: an earlier attempt at this node was interrupted before it could finish. It ran in '
    + 'a different conversation that is not available here, so you cannot see what it did — but it may have '
    + 'left partial changes on disk. Check the current state of anything you are about to create or modify '
    + 'before assuming it is untouched, then carry the task through to the end.';

  const statusMap = (wf) => {
    const map = {};
    for (const [id, s] of wf.state) map[id] = s.status;
    return map;
  };

  const pruneWorkflows = (now = Date.now()) => {
    for (const [id, wf] of workflows) {
      if (wf.finishedAt !== undefined && now - wf.finishedAt >= resultRetentionMs) workflows.delete(id);
    }
    // Bounded memory without blocking new starts: once retained history grows past MAX_WORKFLOWS, evict
    // the OLDEST finished entries first (a finished workflow no longer counts against the start limit
    // below, so this only trims history, never a workflow anyone is still waiting on).
    if (workflows.size > MAX_WORKFLOWS) {
      const finished = [...workflows.values()]
        .filter((wf) => wf.finishedAt !== undefined)
        .sort((a, b) => a.finishedAt - b.finishedAt);
      for (const wf of finished) {
        if (workflows.size <= MAX_WORKFLOWS) break;
        workflows.delete(wf.id);
      }
    }
  };

  /** Resolve a workflow the CURRENT turn is allowed to see/extend. Two authorized callers, fail closed:
   *   - one of the workflow's OWN node child sessions (self-expansion). A delegated node turn always runs
   *     as the anonymous `subagent:subagent` principal (identity.forDelegatedTurn), so its principal can
   *     never match the origin's — membership in `childSessions` is the authorization here, and it is
   *     unforgeable: a session lands there only via THIS workflow's own node `session` events.
   *   - the ORIGIN session itself, which must carry the same real principal that started the workflow. */
  const authWorkflow = (id, callerSessionId) => {
    const wf = workflows.get(id);
    if (!wf) return undefined;
    const sessionId = callerSessionId ?? ctx.currentSessionId();
    if (!sessionId) return undefined;
    if (wf.childSessions.has(sessionId)) return wf;
    // An RPC caller is a delegated node by construction. Its session was derived by the daemon from the
    // active turn, but it carries no origin principal; accepting the origin session here would turn a
    // transport identity into authority that only an authenticated origin turn is meant to have.
    if (callerSessionId !== undefined) return undefined;
    const principal = principalOf(ctx.currentIdentity());
    return principal && wf.originPrincipal === principal && sessionId === wf.originSessionId ? wf : undefined;
  };

  const snapshot = (wf) => {
    if (!wf.emit) return;
    const nodes = wf.nodes.map((n) => {
      const s = wf.state.get(n.id);
      return {
        id: n.id,
        // The whole snapshot re-fans on every tool/step event; the panel/modal only preview the task, so
        // send a bounded slice rather than up to 4k chars × N nodes each time.
        task: n.task.length > SNAPSHOT_TASK_PREVIEW ? `${n.task.slice(0, SNAPSHOT_TASK_PREVIEW)}…` : n.task,
        status: s.status,
        deps: n.deps,
        ...(n.workspaceRef ? { workspaceRef: n.workspaceRef } : {}),
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.tokens !== undefined ? { tokens: s.tokens } : {}),
        ...(s.seconds !== undefined ? { seconds: s.seconds } : {}),
        // The resolved model once the node has started; before that, the declared override if there is one.
        ...(s.model ?? n.model ? { model: s.model ?? n.model } : {}),
        // Same rule for the reasoning effort: the EFFECTIVE level once the node started (which is where
        // an inherited one becomes visible at all), the declaration before that. Without it a workflow
        // node was the one child whose reasoning level the operator could not see anywhere.
        ...(s.thinkingLevel ?? n.thinkingLevel ? { thinkingLevel: s.thinkingLevel ?? n.thinkingLevel } : {}),
        ...(s.startedAt !== undefined ? { startedAt: s.startedAt } : {}),
        ...(s.result ? { result: clip(s.result, SNAPSHOT_RESULT_PREVIEW) } : {}),
        ...(s.error ? { error: clip(s.error, SNAPSHOT_RESULT_PREVIEW) } : {}),
      };
    });
    // Always the ORIGIN's WorkflowStart call, never whatever tool call is executing right now: a node's
    // own turn can trigger a snapshot (WorkflowAddNodes), and it must still land on the origin's row.
    // `background` rides the snapshot because it is not display trivia: the host reads it to decide which
    // node sessions a parent abort must SPARE, and the CLI to decide what Ctrl+B still has left to detach.
    try {
      wf.emit({
        id: wf.id, toolCallId: wf.toolCallId, ...(wf.title ? { title: wf.title } : {}),
        status: wf.status, ...(wf.background ? { background: true } : {}),
        ...(wf.workspaceRef ? { workspaceRef: wf.workspaceRef } : {}), nodes,
      });
    }
    catch (e) { ctx.logger.warn(`workflow snapshot fan-out failed: ${errorText(e)}`); }
  };

  /** Build one node's access from the captured parent scope + the node's own model/tool narrowing —
   *  mirrors the `delegate` access assembly exactly (can only ever narrow the parent). May reject. */
  const buildNodeAccess = async (wf, node) => {
    // Nodes added by a workflow child inherit that child's exact effective boundary, never the origin's
    // broader one. Original nodes and origin-added nodes continue to inherit the workflow parent.
    const parentAccess = wf.nodeParentAccess.get(node.id) ?? wf.parentAccess;
    const parentModel = wf.nodeParentModel.get(node.id) ?? wf.parentModel;
    let model = parentModel ? { provider: parentModel.provider, model: parentModel.model } : undefined;
    // One catalog read for the model override and the level check, which is measured against whichever
    // model this node ends up on.
    const list = node.model || node.thinkingLevel ? await ctx.listModels().catch(() => []) : [];
    if (node.model) {
      const hit = list.find((m) => `${m.provider}/${m.model}` === node.model || m.model === node.model);
      if (!hit) throw new Error(`model "${node.model}" is not available for node "${node.id}"`);
      model = { provider: hit.provider, model: hit.model };
    }
    // A node's own `thinkingLevel` is validated against that model's ladder and fails the node loudly;
    // without one the node inherits the workflow origin's reasoning effort (the host drops it if the
    // node's model has no such level), mirroring the delegate tool.
    const resolvedThinking = resolveThinkingLevel(node.thinkingLevel, parentModel?.thinkingLevel, model, list);
    if (resolvedThinking.error) throw new Error(`${resolvedThinking.error} (node "${node.id}")`);
    const thinkingLevel = resolvedThinking.level;
    // A named sub-agent TYPE, validated against the live catalog exactly as the delegate tool does — the
    // host resolves the name into the node's role prompt, toolset and (for a read-only type) boundary.
    let agentType;
    if (node.subagentType) {
      const types = ctx.subagentTypes?.() ?? [];
      if (!types.some((t) => t.name === node.subagentType)) {
        throw new Error(`unknown subagent_type "${node.subagentType}" for node "${node.id}". Available: ${types.map((t) => t.name).join(', ') || '(none)'}.`);
      }
      agentType = node.subagentType;
    }
    // Remote expansion is offered only when BOTH routing and reverse-channel capability agree. This keeps
    // old/unwired runners on the conservative deny path, while a current runner reaches this process-local
    // DAG through the daemon-owned RPC endpoint. Both reads are deterministic capability checks; no
    // per-request ids or timestamps enter the briefing and destabilize its prompt-cache prefix.
    const remoteDispatch = ctx.delegatedTurnsOutOfProcess?.() === true;
    const remoteExpansionUnavailable = remoteDispatch
      && ctx.delegatedWorkflowExpansionAvailable?.() !== true;
    const restricted = resolveDelegateTools(parentAccess.toolPolicy?.allow, node.tools, ctx.toolNames());
    if (restricted.error) throw new Error(restricted.error);
    const narrowedPolicy = restricted.allow
      ? { ...(parentAccess.toolPolicy?.deny ? { deny: parentAccess.toolPolicy.deny } : {}), allow: restricted.allow }
      : parentAccess.toolPolicy;
    // Silence in the briefing is not protection: without this deny an unsupported remote node still holds
    // the full toolset. The deny also overrides an explicit tools:['WorkflowAddNodes'] fallback attempt.
    const toolPolicy = remoteExpansionUnavailable && !toolListCovers(narrowedPolicy?.deny, 'WorkflowAddNodes')
      ? { ...(narrowedPolicy ?? {}), deny: [...(narrowedPolicy?.deny ?? []), 'WorkflowAddNodes'] }
      : narrowedPolicy;
    // Invite only nodes whose known effective boundary can call the tool; hidden/denied tools must not
    // appear in their instructions. Typed presets are resolved later by the host, so stay conservative.
    const canExpand = !agentType && !parentAccess.readOnly && !node.readOnly
      && (!node.tools || node.tools.includes('WorkflowAddNodes'))
      && !remoteExpansionUnavailable && toolPolicyAllows(toolPolicy, 'WorkflowAddNodes');
    // A fixed budget. It used to be an operator knob shared with the parent-to-child hand-over; that
    // hand-over is gone (forking replaced it), and what remains is internal DAG plumbing whose size is a
    // property of the packaging rather than a preference.
    const contextTotal = resolveContextTotalChars(undefined);
    const contextParts = [];
    if (canExpand) {
      contextParts.push(`You are node "${node.id}" of a running workflow (id "${wf.id}"). Only if completing this `
        + `task clearly reveals concrete follow-up sub-tasks, you may call WorkflowAddNodes with that workflowId `
        + `to add them; otherwise just finish your task and report.`);
    }
    // Ask for the handover BEFORE the node starts working, or it writes its report and stops. Only nodes
    // that actually have successors are asked; for a leaf the section would be pure noise.
    const dependentIds = wf.nodes.filter((n) => (n.deps ?? []).includes(node.id)).map((n) => n.id);
    if (dependentIds.length) contextParts.push(handoverInstruction(dependentIds));
    // What the node waited for. Without this a dependency edge only ORDERS the run: the node still starts
    // with an empty context and has to re-derive — or invent — whatever its dependencies already produced,
    // which is precisely the "gather → analyze → write" shape the tool advertises. Appended last, after the
    // workflow-wide shared context, so the stable part of the prefix stays identical across nodes.
    //
    // DIRECT dependencies only, and only their handovers. A transitive chain used to arrive in full: the
    // fourth node of a pipeline read three complete reports, most of them about work it was not doing.
    // A handover can arrive from the recovery journal, which is an agent-writable file: take it only when it
    // still has the shape the blocks below slice, never on truthiness alone.
    const depResults = (node.deps ?? [])
      .map((id) => ({ id, handover: wf.state.get(id)?.handover }))
      .filter((d) => typeof d.handover?.text === 'string' && d.handover.text.length > 0)
      .map((d) => ({ id: d.id, result: d.handover.text, derived: d.handover.derived === true }));
    if (depResults.length) {
      // Each dependency gets its OWN prompt chunk (several share one only when the DAG is wider than the
      // chunk budget), so the per-chunk ceiling bounds a SINGLE result rather than all of them joined.
      //
      // The division is against EXACT packaging, not estimates of it: dependencyContextChunks puts the
      // context header on the first chunk and reserves the truncation marker on every chunk, and a block
      // costs its own heading plus the node id. Rounded guesses plus a forced minimum slice is what made a
      // wide fan-in overrun the total — the chunker then clipped and dropped the last groups, and the node
      // ran on dependencies it had never been shown, with nothing in its context saying so.
      const spent = contextParts.reduce((n, part) => n + part.length + TRUNCATION_MARKER.length,
        CONTEXT_HEADER.length + 1);
      // Chunks left for the results, after the parts already queued and the note that introduces them.
      const slots = Math.max(1, MAX_CONTEXT_CHUNKS - contextParts.length - 1);
      const perChunk = Math.ceil(depResults.length / slots);
      const groups = Math.ceil(depResults.length / perChunk);
      // Reserve the note at its WORST case — every dependency named — so the reservation cannot be
      // undercut by which of them turns out to need truncating.
      const introChars = depIntro(depResults.map((d) => d.id), depResults.map((d) => d.id)).length
        + TRUNCATION_MARKER.length;
      const blockChars = depResults.reduce((n, d) => n + depBlockHeading(d.id).length + TRUNCATION_MARKER.length, 0)
        + DEP_BLOCK_SEPARATOR.length * (depResults.length - groups);
      const perDep = Math.min(
        Math.floor((contextTotal - spent - introChars - groups * TRUNCATION_MARKER.length - blockChars)
          / depResults.length),
        Math.floor((MAX_CONTEXT_CHUNK_CHARS - TRUNCATION_MARKER.length
          - perChunk * (Math.max(...depResults.map((d) => depBlockHeading(d.id).length)) + TRUNCATION_MARKER.length)
          - DEP_BLOCK_SEPARATOR.length * (perChunk - 1)) / perChunk),
      );
      // Refuse rather than starve. Below this the node would be reasoning from fragments, and forcing the
      // minimum anyway is precisely what overran the budget and lost whole dependencies.
      if (perDep < DEP_MIN_CHARS) {
        throw new Error(`node "${node.id}" waits on ${depResults.length} dependencies whose results cannot fit its `
          + `${contextTotal}-char context budget: each would get ${Math.max(0, perDep)} chars, below the `
          + `${DEP_MIN_CHARS}-char minimum. Aggregate them through intermediate nodes.`);
      }
      // Say so IN the context. A node reading a truncated dependency cannot tell whether the finding it is
      // looking for was absent or merely cut off, and that difference decides whether it should re-derive.
      contextParts.push(depIntro(
        depResults.filter((d) => d.derived).map((d) => d.id),
        depResults.filter((d) => d.result.length > perDep).map((d) => d.id),
      ));
      for (let i = 0; i < depResults.length; i += perChunk) {
        contextParts.push(depResults.slice(i, i + perChunk)
          .map((d) => `${depBlockHeading(d.id)}${clipDep(d.result, perDep)}`)
          .join(DEP_BLOCK_SEPARATOR));
      }
    }
    const context = dependencyContextChunks(contextParts, contextTotal);
    const access = {
      ...parentAccess,
      ...(toolPolicy ? { toolPolicy } : {}),
      model,
      parentSessionId: wf.originSessionId,
      ...(!node.workspaceRef && !wf.workspaceRef && !parentAccess.workspaceRef && wf.parentCwd ? { cwd: wf.parentCwd } : {}),
      ...(node.workspaceRef ?? wf.workspaceRef ?? parentAccess.workspaceRef
        ? { workspaceRef: node.workspaceRef ?? wf.workspaceRef ?? parentAccess.workspaceRef }
        : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      // read_only selects the host-side read-only MODE (preset toolset + minted boundary), same as delegate.
      ...(node.readOnly ? { readOnly: true } : {}),
      // A typed node gets its role prompt from the host (resolved from `agentType`); an untyped node uses
      // the generic workflow-node prompt. Mirrors the delegate tool's typed/untyped split.
      // A FORK node carries no role prompt at all: its system prompt is the origin conversation's, byte
      // for byte, and the worker rules travel in the directive message instead.
      ...(node.fork ? { fork: true } : agentType
        ? { agentType }
        : { prompt: 'You are a focused sub-agent running one node of a workflow. Complete the task and report the result concisely — no preamble.' }),
      // A node's DIRECT dependencies' handovers. This is the DAG's own data flow, sibling to sibling, and
      // is the one hand-over forking cannot replace — a dependency is not a parent, so there is no cache
      // of its to read.
      //
      // NOT for a fork node. Its system prompt is the origin conversation's byte for byte, so the host
      // appends nothing to it (see packDelegatedPromptAppend at the fork boundary) and anything handed
      // over this way would be dropped without a trace. A fork node gets the same blocks in its DIRECTIVE
      // message instead — see the `handover` below.
      ...(context.length && !node.fork ? { context } : {}),
    };
    // The fork node's copy of exactly those blocks, as text. It rides with the directive, which is the one
    // block that already sits AFTER the shared prefix, so delivering it costs the node its own uncached
    // block and moves no cached byte. Empty for every non-fork node, whose blocks travel in `context`.
    return { access, handover: node.fork ? context.join('\n\n') : '' };
  };

  const runNode = async (wf, node) => {
    const ns = wf.state.get(node.id);
    ns.startedAt = ns.startedAt ?? Date.now();
    const onEvent = (e) => {
      if (e.type === 'session' && e.sessionId) {
        ns.sessionId = e.sessionId; wf.childSessions.add(e.sessionId);
        // The host registers a delegated call BEFORE its first await but only emits `session` after the
        // lock and the spawn, so a child that was already launching when the run was cancelled surfaces its
        // id only now — too late for the sweep in WorkflowStop/reload, which can only see ids it has. Stop
        // it here instead, or it would keep running tools and burning tokens after an announced stop.
        // `wf.stopChild` carries the workflow's own origin turn, so this reaches the child no matter whose
        // turn is on the stack; a stop the host still refuses is reported rather than dropped.
        if (wf.finished) {
          wf.stopChild(e.sessionId)?.catch((err) => ctx.logger.warn(
            `workflow ${wf.id}: node "${node.id}" child ${e.sessionId} could not be stopped after cancellation: ${errorText(err)}`));
        }
        writeJournal(wf); // the channel/session pair is what lets a boot resume re-enter this node's conversation
        snapshot(wf);
      }
      else if (e.type === 'tool' && e.name) {
        ns.tools += 1;
        // A node's own sticky note, on the node state so it survives every snapshot in between. The node
        // needs no `name` of its own: its declared `id` is already the short handle its row is labelled
        // with and the one WorkflowAddNodes addresses it by.
        ({ reason: ns.reason, detail: ns.detail } = foldToolDetail(e, ns.reason));
        ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000);
        snapshot(wf);
      }
      else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { ns.tokens = e.usage.totalTokens; ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000); snapshot(wf); }
    };
    try {
      const { access, handover } = await buildNodeAccess(wf, node);
      // buildNodeAccess is an async boundary that can take a while — with an explicit model it may wait on
      // a live /models request — and WorkflowStop or a plugin reload can settle the run inside that window.
      // Without this fence the stale continuation would still spawn a child, one nobody can reach or abort:
      // the very orphan the cancellation exists to prevent.
      if (wf.finished) { ns.status = 'error'; ns.error = 'cancelled before the node started'; return; }
      // The EFFECTIVE model, not the node's override. `node.model` is only set when the caller named a
      // different one, so a node that inherits — the common case — would otherwise report nothing at all,
      // which is exactly when you most want to see what is actually running.
      ns.model = access.model ? `${access.model.provider}/${access.model.model}` : undefined;
      ns.thinkingLevel = access.thinkingLevel;
      snapshot(wf);
      // A node's child session is keyed by this channel id (channelSessionId derives one from the other), so
      // reusing the id on a resume drops the retry back into the SAME conversation — transcript intact,
      // nothing to rehydrate. A first run mints a fresh one.
      const channelId = ns.channelId || `wf-${wf.id}-${node.id}-${randomUUID()}`;
      ns.channelId = channelId;
      const collectSource = { platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access };
      const raw = await runNodeTurn(wf, node, ns, collectSource, onEvent, handover);
      // A node whose turn ended with nothing to say has not done its task — its dependents would inherit an
      // empty handover and the parent a blank line marked DONE. It fails the workflow like any other error,
      // so the summary says so up front and WorkflowResume re-runs it.
      const reply = raw?.trim() ? raw : 'Error: the node ended its turn without returning a result';
      if (reply.startsWith('Error:')) { ns.status = 'error'; ns.error = clip(reply.slice('Error:'.length).trim() || reply, MAX_RESULT_CHARS); }
      // The node's answer reaches the parent through `summarize`: keep its END, where a report's conclusion
      // is. An error stays head-first — it leads with what broke. Its DEPENDENTS get the handover instead,
      // taken from the raw reply so a result clipped for the parent cannot cost them the section too.
      else { ns.status = 'done'; ns.result = clipTail(reply, MAX_RESULT_CHARS); ns.handover = handoverOf(reply); }
    } catch (e) {
      ns.status = 'error';
      ns.error = clip(errorText(e), MAX_RESULT_CHARS);
    }
    ns.seconds = Math.round((Date.now() - (ns.startedAt ?? Date.now())) / 1000);
    writeJournal(wf); // node terminal: the FULL result must reach the journal — snapshots only carry a preview
    snapshot(wf);
    tick(wf);
  };

  /** One node turn: normally the task prompt (plus the resume/restart note, plus a fork node's dependency
   *  handover) into the node's channel. A node handed back by a BOOT resume that still has its child
   *  session gets the host's continuation first — the same one a delegated child gets after a restart: a
   *  transcript that already ends on the node's answer IS the result, an interrupted turn is continued
   *  silently over `[interrupted]` tool results, and only an empty transcript falls through to the
   *  ordinary prompt. Prompting such a node with its task again made it start over on top of half-done
   *  work (and its earlier answer, when it had one, was simply lost). The continuation is consumed once:
   *  a later retry of the same node is a fresh prompt again. */
  const runNodeTurn = async (wf, node, ns, source, onEvent, handover = '') => {
    if (wf.continueNode && ns.sessionId && wf.continueOnce?.delete(node.id)) {
      let continued;
      try { continued = await wf.continueNode(ns.sessionId, onEvent); }
      catch (e) {
        ctx.logger.warn(`workflow ${wf.id}: node "${node.id}" could not be continued in ${ns.sessionId}, prompting it afresh: ${errorText(e)}`);
        continued = { outcome: 'empty' };
      }
      if (continued.outcome !== 'empty') {
        ctx.logger.info(`workflow ${wf.id}: node "${node.id}" ${continued.outcome === 'answered' ? 'had already answered before the restart' : 'continued its interrupted turn'}`);
        return continued.reply;
      }
    }
    // Directive, then the retry note, then a FORK node's dependency handover (empty for every other node,
    // which receives the same blocks as system-prompt context). Instructions stay together at the top and
    // the bulk background material comes last, immediately before the node starts work.
    return getRun()(source, [node.task, ns.taskNote, handover].filter(Boolean).join('\n\n'), onEvent);
  };

  /** Launch every node whose dependencies are all done. Marks them running BEFORE the async spawn so a
   *  re-entrant tick (from a concurrently finishing node) can never double-launch one. Coalesced + safe. */
  const tick = (wf) => {
    if (wf.finished) return;
    const ready = readyNodeIds(wf.nodes, statusMap(wf));
    if (ready.length) {
      for (const id of ready) wf.state.get(id).status = 'running';
      snapshot(wf);
      for (const id of ready) void runNode(wf, wf.nodes.find((n) => n.id === id));
    }
    maybeFinish(wf);
  };

  const maybeFinish = (wf) => {
    if (wf.finished) return;
    const states = [...wf.state.values()];
    const anyRunning = states.some((s) => s.status === 'running');
    // With nothing running and nothing newly-ready, any still-pending node is permanently blocked by a
    // failed dependency — the workflow is done (as far as it can get).
    if (anyRunning || readyNodeIds(wf.nodes, statusMap(wf)).length) return;
    wf.finished = true;
    wf.resolveDone?.();
  };

  const summarize = (wf) => {
    const lines = [`Workflow ${wf.title ? `"${wf.title}" ` : ''}finished with status: ${wf.status}.`];
    for (const n of wf.nodes) {
      const s = wf.state.get(n.id);
      lines.push('', `[${n.id}] ${s.status.toUpperCase()}${n.deps.length ? ` (after ${n.deps.join(', ')})` : ''}`);
      if (s.status === 'done') lines.push(s.result || '(no output)');
      else if (s.status === 'error') lines.push(`Error: ${s.error}`);
      // A node the cancellation caught mid-run is NOT a node that never ran: it may already have edited
      // files or run commands, and a resume puts it back to work over that partial state. Reporting it as
      // "did not run" is what would make someone resume, or redo the work by hand, without checking.
      else if (s.status === 'running') lines.push('(interrupted while running — it may have already made partial changes)');
      else lines.push(wf.status === 'cancelled' ? '(did not run — the workflow was cancelled)' : '(did not run — a dependency failed)');
    }
    return lines.join('\n');
  };

  /** Start the DAG ONCE and resolve with the final summary when it settles. The single `tick(wf)` here is
   *  the only launch point, so a foreground blocking call and a detach/background call share ONE run: a
   *  detach never re-starts the engine, it only stops the parent waiting on it. Settles the terminal
   *  status, finishes the row (drives retention) and yields the summary the caller returns or delivers. */
  const runToCompletion = (wf) => {
    wf.status = 'running';
    snapshot(wf);
    return new Promise((resolve) => { wf.resolveDone = resolve; tick(wf); }).then(() => {
      // A cancel OWNS its own terminalization: cancelWorkflow already settled the status, stamped
      // finishedAt and published the terminal snapshot before releasing this wait. Re-running it here would
      // re-stamp the finish time and broadcast/persist a second terminal snapshot for one cancellation —
      // once per running workflow on a plugin reload. Only summarize.
      if (wf.status !== 'cancelled') {
        wf.status = [...wf.state.values()].some((s) => s.status === 'error') ? 'error' : 'done';
        wf.finished = true;
        wf.finishedAt = Date.now();
        snapshot(wf);
      }
      // Terminal either way (done/error above, cancelled settled by cancelWorkflow): the journal's job is
      // over — a journal on disk at boot is precisely the marker of an INTERRUPTED run.
      deleteJournal(wf.id);
      return summarize(wf);
    });
  };

  /** Deliver a detached/background workflow's summary through the turn-captured durable host sink, so an
   *  explicit `background` and a Ctrl+B detach follow the exact same result path. A never-detached
   *  foreground workflow returns its summary inline instead, so this is gated on `wf.background`. */
  const deliverCompletion = (wf, summary) => {
    if (!wf.background || !wf.emitCompletion) return;
    try {
      // `run` tells the host which run of this DAG the summary closes: a resumed run's summary must reach
      // the parent as a NEW result, not be dropped as a duplicate of the first one it already heard.
      wf.emitCompletion({ id: wf.id, toolCallId: wf.toolCallId, ...(wf.title ? { title: wf.title } : {}), status: wf.status, result: summary, run: wf.run ?? 0 });
    } catch (e) {
      ctx.logger.warn(`workflow completion persistence failed: ${errorText(e)}`);
    }
  };

  /** Drive an already-launched `completion` (a `runToCompletion(wf)` promise) to its tool result exactly
   *  like WorkflowStart does — shared with WorkflowResume so both surfaces behave identically. Either
   *  blocks for it (letting a live Ctrl+B detach race it into the background) or, when background was
   *  requested up front, returns the handle immediately and delivers the summary through the durable sink
   *  once it lands. */
  const driveResult = async (wf, completion, requestedBackground) => {
    if (requestedBackground) {
      // No durable sink on this surface (worker/cron) — block rather than silently drop the result.
      if (!wf.emitCompletion) return ok(await completion);
      void completion.then((summary) => deliverCompletion(wf, summary));
      return ok(
        `Started background workflow ${wf.id}.\n`
          + 'Its result is delivered to you automatically in a NEW turn when it finishes — you do not have to '
          + 'fetch it. Do any other useful work now, then end your turn. If there is nothing else to do, say so '
          + 'briefly and end the turn: waiting inside this turn only delays the result.',
        { workflowId: wf.id, status: 'running' },
      );
    }
    const outcome = await raceDetach((resolve) => { wf.resolveDetached = resolve; }, () => completion);
    if (!outcome.detached) return ok(outcome.value);
    void completion.then((summary) => deliverCompletion(wf, summary));
    return ok(
      `The user moved this workflow to the background. It is still running as ${wf.id}; continue helping the `
      + 'user now. Its result is delivered to you automatically in a new turn when it finishes, so once you have '
      + 'nothing else to do, end your turn instead of waiting or polling for it.',
      { workflowId: wf.id, status: 'running', detached: true },
    );
  };

  /** Settle a workflow as cancelled — the one place a run is stopped from the outside, shared by the
   *  abort seam, the reload teardown and WorkflowStop. Marking it finished BEFORE anything else is what
   *  stops the engine: `tick` bails on `finished`, so a node settling afterwards cannot launch the next
   *  one. The snapshot publishes the terminal status (the durable row stops claiming the DAG is running)
   *  and `resolveDone` releases whoever waits on it — a blocking WorkflowStart returns the cancelled
   *  summary, a background one delivers it through its durable sink. Node children are NOT touched here;
   *  each caller decides whether it owns their teardown. */
  const cancelWorkflow = (wf) => {
    wf.status = 'cancelled';
    wf.finished = true;
    wf.finishedAt = Date.now();
    snapshot(wf);
    wf.resolveDone?.();
  };

  /** The abort seam core calls when a parent turn is torn down (Esc-Esc, /stop, queue interrupt). The
   *  abort tree kills the node children that are RUNNING; this stops the engine from launching the rest
   *  — without it, every node whose deps had already finished would spawn a fresh child AFTER the abort,
   *  with nothing left alive to tear it down. Running nodes are left to settle: their sessions are being
   *  aborted by the same cascade, and `tick` no longer relaunches anything once `finished` is set.
   *
   *  A BACKGROUND workflow is deliberately spared. Outliving the turn that started it is the whole promise
   *  of Ctrl+B and of background:true, and the host spares a detached delegate's children on this same
   *  abort for exactly that reason. Without the check, any later Esc-Esc in the conversation — related or
   *  not — silently killed work the user had been told keeps running. */
  /** The single mutation path for local tool calls and runner RPC calls alike. Authorization, node
   *  normalization, duplicate/cycle checks and the origin-anchored snapshot all stay in this daemon-owned
   *  engine; the runner only transports the opaque node declarations. */
  const addNodesFromSession = (workflowId, rawNodes, callerSessionId, callerAccess, callerModel) => {
    const wf = authWorkflow(workflowId, callerSessionId);
    if (!wf) throw new Error(`no running workflow ${workflowId} you can extend`);
    if (wf.finished) throw new Error(`workflow ${workflowId} has already finished; start a new one`);
    const sessionId = callerSessionId ?? ctx.currentSessionId();
    const childAccess = sessionId !== wf.originSessionId
      ? (callerAccess ? delegableAccess(callerAccess) : undefined)
      : undefined;
    if (sessionId !== wf.originSessionId && !childAccess) {
      throw new Error('the workflow node caller has no delegable access boundary');
    }
    const { nodes: validatedNodes, error } = mergeWorkflowNodes(wf.nodes, rawNodes);
    if (error) throw new Error(error);
    const effectiveParentAccess = childAccess ?? wf.parentAccess;
    const workspaceCeiling = wf.workspaceRef ?? effectiveParentAccess.workspaceRef;
    if (wf.workspaceRef && effectiveParentAccess.workspaceRef && !sameWorkspaceRef(wf.workspaceRef, effectiveParentAccess.workspaceRef)) {
      throw new Error('the workflow node caller is scoped to a different workspace');
    }
    const scopedParentAccess = workspaceCeiling ? { ...effectiveParentAccess, workspaceRef: workspaceCeiling } : effectiveParentAccess;
    const nodes = resolveNodeWorkspaces(validatedNodes, scopedParentAccess, workspaceCeiling);
    for (const node of nodes) {
      wf.nodes.push(node);
      wf.state.set(node.id, freshNodeState());
      if (childAccess) {
        wf.nodeParentAccess.set(node.id, scopedParentAccess);
        if (callerModel) wf.nodeParentModel.set(node.id, callerModel);
      }
    }
    writeJournal(wf);
    snapshot(wf);
    tick(wf);
    return { added: nodes.map((node) => node.id) };
  };

  /** Boot resume of a restart-orphaned workflow (see WorkflowRecoveryControl in core's api.ts). Core has
   *  already CLAIMED the durable `running` row; this rebuilds the in-memory workflow from the recovery
   *  journal and re-runs it with WorkflowResume's exact semantics — DONE nodes keep their (full,
   *  journaled) results and feed their dependents, everything else is retried, a node that had a session
   *  resumes into it via its journaled channel id. Two deliberate differences from a live resume: the
   *  access boundary is REPLAYED from the journal rather than re-captured (there is no current turn at
   *  boot; the journal was captured by this same daemon from a genuine turn, and an exact match is what
   *  lets node sessions respawn at all), and the workflow is forced to BACKGROUND — the origin's blocking
   *  turn died with the restart, so the hook-provided durable sink is the only path its summary has. */
  const resumeInterrupted = async ({ workflowId, parentSessionId, toolCallId, trustedWorkspaceRef, trustedNodeWorkspaceRefs, hooks }) => {
    if (!getRun()) return { resumed: false, reason: 'the delegated run handler is not connected' };
    if (workflows.has(workflowId)) return { resumed: false, reason: 'already held in memory' };
    let raw;
    try { raw = JSON.parse(readFileSync(journalPath(workflowId), 'utf8')); }
    catch (e) { return { resumed: false, reason: `no usable recovery journal (${errorText(e)})` }; }
    if (!isRecord(raw) || (raw.v !== 1 && raw.v !== 2) || raw.id !== workflowId || raw.toolCallId !== toolCallId
      || raw.originSessionId !== parentSessionId || typeof raw.originPrincipal !== 'string' || !raw.originPrincipal
      || !isRecord(raw.parentAccess) || !Array.isArray(raw.nodes) || !Array.isArray(raw.state)) {
      deleteJournal(workflowId); // mismatched/corrupt — it can never resume anything, so stop it lingering
      return { resumed: false, reason: 'recovery journal does not match the claimed workflow' };
    }
    const journalWorkspaceRef = isRecord(raw.workspaceRef) ? raw.workspaceRef : undefined;
    if ((trustedWorkspaceRef || journalWorkspaceRef) && !sameWorkspaceRef(trustedWorkspaceRef, journalWorkspaceRef)) {
      deleteJournal(workflowId);
      return { resumed: false, reason: 'the journal workspace does not match the trusted workflow snapshot' };
    }
    const trustedNodes = trustedNodeWorkspaceRefs ?? {};
    for (const rawNode of raw.nodes) {
      if (!isRecord(rawNode) || typeof rawNode.id !== 'string') {
        deleteJournal(workflowId);
        return { resumed: false, reason: 'the recovery journal contains a malformed workflow node' };
      }
      const journalRef = isRecord(rawNode.workspaceRef) ? rawNode.workspaceRef : undefined;
      const trustedRef = trustedNodes[rawNode.id];
      if ((trustedRef || journalRef) && !sameWorkspaceRef(trustedRef, journalRef)) {
        deleteJournal(workflowId);
        return { resumed: false, reason: `node "${rawNode.id}" workspace does not match the trusted workflow snapshot` };
      }
    }

    // The journal is an agent-writable file, so every boundary read from it is UNTRUSTED authority. Core
    // re-validates each one against the origin user's authority AS IT STANDS NOW; the first refusal kills
    // the whole resume (core then terminalizes with a durable notice). Never resume on a boundary this
    // process cannot get vouched for — including every dynamically-added node's narrower one.
    const rejectedBoundary = (() => {
      const parent = hooks.validateBoundary(raw.parentAccess);
      if (!parent.ok) return parent.reason ?? 'the journaled workflow boundary was rejected';
      const rawNodeAccess = Array.isArray(raw.nodeParentAccess) ? raw.nodeParentAccess : [];
      for (const entry of rawNodeAccess) {
        if (!Array.isArray(entry) || entry.length !== 2) return 'malformed journaled node boundary';
        const node = hooks.validateBoundary(entry[1]);
        if (!node.ok) return node.reason ?? 'a journaled node boundary was rejected';
      }
      const nodeAccess = new Map(rawNodeAccess);
      for (const rawNode of raw.nodes) {
        if (!isRecord(rawNode) || typeof rawNode.id !== 'string') return 'malformed journaled workflow node';
        const inherited = nodeAccess.get(rawNode.id) ?? raw.parentAccess;
        if (!isRecord(inherited)) return 'malformed journaled node boundary';
        const workspaceRef = isRecord(rawNode.workspaceRef)
          ? rawNode.workspaceRef
          : isRecord(raw.workspaceRef) ? raw.workspaceRef : inherited.workspaceRef;
        if (!workspaceRef) continue;
        const scoped = hooks.validateBoundary({ ...inherited, workspaceRef });
        if (!scoped.ok) return scoped.reason ?? 'a journaled node workspace was rejected';
      }
      return undefined;
    })();
    if (rejectedBoundary) {
      deleteJournal(workflowId); // core terminalizes the claim now; a lingering journal could only mislead
      return { resumed: false, reason: `refusing to replay journaled authority: ${rejectedBoundary}` };
    }
    pruneWorkflows();
    if ([...workflows.values()].filter((w) => w.finishedAt === undefined).length >= MAX_WORKFLOWS) {
      return { resumed: false, reason: `too many workflows (${MAX_WORKFLOWS}) are already running` };
    }
    const wf = {
      id: workflowId,
      toolCallId,
      title: typeof raw.title === 'string' && raw.title ? raw.title : undefined,
      status: 'running',
      nodes: raw.nodes,
      state: new Map(),
      nodeParentAccess: new Map(Array.isArray(raw.nodeParentAccess) ? raw.nodeParentAccess : []),
      nodeParentModel: new Map(Array.isArray(raw.nodeParentModel) ? raw.nodeParentModel : []),
      parentAccess: raw.parentAccess,
      parentModel: isRecord(raw.parentModel) ? raw.parentModel : undefined,
      parentCwd: typeof raw.parentCwd === 'string' && raw.parentCwd ? raw.parentCwd : undefined,
      workspaceRef: isRecord(raw.workspaceRef) ? raw.workspaceRef : undefined,
      emit: (update) => hooks.emit(update),
      originSessionId: parentSessionId,
      originPrincipal: raw.originPrincipal,
      // No origin turn exists at boot; the hook is core's ownership-guarded stop for the origin's children.
      stopChild: (sessionId) => hooks.stopChild(sessionId),
      childSessions: new Set(),
      finished: false,
      finishedAt: undefined,
      resolveDone: undefined,
      background: true,
      // A boot resume is a run of its own too: the interrupted run may already have delivered a summary
      // (a cancelled-on-restart one), and this run's must not be dropped as its duplicate.
      run: (Number.isInteger(raw.run) && raw.run >= 0 ? raw.run : 0) + 1,
      emitCompletion: (completion) => hooks.complete(completion),
      resolveDetached: undefined,
      // Boot-only: nodes whose child session survived get ONE continuation (runNodeTurn) instead of a
      // fresh prompt. Absent on a live WorkflowResume, whose interrupted children were stopped on purpose.
      continueNode: typeof hooks.continueNode === 'function' ? hooks.continueNode : undefined,
      continueOnce: new Set(),
    };
    const journaled = new Map(raw.state.filter((entry) =>
      Array.isArray(entry) && typeof entry[0] === 'string' && isRecord(entry[1])));
    let done = 0;
    for (const n of wf.nodes) {
      const prev = journaled.get(n.id);
      if (prev?.sessionId && typeof prev.sessionId === 'string') wf.childSessions.add(prev.sessionId);
      if (prev?.status === 'done') {
        const restored = { ...freshNodeState(), ...prev };
        // A journal written before handovers existed — or by a node whose handover did not survive the
        // write — carries a result and nothing else. Deriving it here is what keeps a dependent from
        // resuming with an EMPTY dependency block, which is worse than the tail it would have had: the
        // node would silently re-derive or invent what its dependency already established.
        if (!isRecord(restored.handover) && typeof restored.result === 'string') {
          restored.handover = handoverOf(restored.result);
        }
        wf.state.set(n.id, restored);
        done += 1;
        continue;
      }
      // WorkflowResume's reset, under a boundary that matches by construction (same journaled access):
      // a node that ran resumes inside its own conversation; one that never launched starts clean.
      const next = freshNodeState();
      if (prev?.sessionId) {
        if (typeof prev.channelId === 'string' && prev.channelId) {
          next.channelId = prev.channelId; next.taskNote = RESUME_NOTE;
          next.sessionId = prev.sessionId; wf.continueOnce.add(n.id);
        }
        else next.taskNote = RESTART_NOTE;
      }
      wf.state.set(n.id, next);
    }
    workflows.set(wf.id, wf);
    writeJournal(wf);
    const completion = runToCompletion(wf).catch((e) => {
      wf.status = 'error';
      wf.finished = true;
      wf.finishedAt = Date.now();
      return `Error: workflow failed: ${errorText(e)}`;
    });
    void completion.then((summary) => deliverCompletion(wf, summary));
    ctx.logger.info(`workflow ${wf.id} resumed from its recovery journal (${done}/${wf.nodes.length} node(s) already done)`);
    return { resumed: true };
  };

  const cancelForSession = (sessionId) => {
    let cancelled = 0;
    for (const wf of workflows.values()) {
      if (wf.finished || wf.background || wf.originSessionId !== sessionId) continue;
      cancelWorkflow(wf);
      cancelled += 1;
    }
    return { cancelled };
  };
  /** Ctrl+B seam (see api.ts KnownControls.workflow). Flip every foreground workflow blocking THIS origin
   *  into a background one: resolve the parent's blocking wait — never abort the nodes, they keep running —
   *  and mark it for automatic delivery. An already-background workflow is skipped, so it is never counted
   *  as newly detached. Foreground and background share ONE run, exactly like the sub-agent jobs. */
  const detachForeground = (sessionId, principal) => {
    let detached = 0;
    for (const wf of workflows.values()) {
      if (wf.finished || wf.background || wf.status !== 'running'
        || wf.originSessionId !== sessionId || wf.originPrincipal !== principal) continue;
      wf.background = true;
      wf.resolveDetached?.();
      wf.resolveDetached = undefined;
      snapshot(wf);
      detached += 1;
    }
    return { detached };
  };
  // The `workflow` control name is taken by cancelForSession, so the detach seam rides the same control.
  ctx.registerControl('workflow', {
    cancelForSession: ({ sessionId }) => cancelForSession(sessionId),
    detachForeground: ({ sessionId, principal }) => detachForeground(sessionId, principal),
    activeCount: () => [...workflows.values()].filter((wf) => !wf.finished).length,
    // Does THIS engine still hold the DAG? The durable row alone cannot answer that: when a terminal
    // snapshot fails to persist (or boot reconcile misses one), the row claims `running` forever while
    // the engine dropped the workflow long ago. Status reads consult this instead of inferring liveness
    // from the origin PI session, which outlives — and is outlived by — the DAG independently.
    isWorkflowLive: ({ workflowId }) => {
      const wf = workflows.get(workflowId);
      return !!wf && !wf.finished;
    },
    // Caller identity and access are accepted only on this internal control. SubagentRunnerHost derives both
    // from a daemon-minted active turn before this method is reachable; the IPC payload carries neither.
    addNodesFromSession: ({ callerSessionId, callerAccess, callerModel, workflowId, nodes }) =>
      addNodesFromSession(workflowId, nodes, callerSessionId, callerAccess, callerModel),
    resumeInterrupted,
  });

  /** A plugin reload replaces THIS closure: the fresh instance registers its own empty `workflows` map,
   *  so anything still held here becomes unreachable — cancelForSession can no longer stop it, and
   *  WorkflowStatus/Resume/Stop can no longer see it. The runtime state cannot simply be handed over: the
   *  turn emitters, the host `run` handler and the whole platform adapter behind it are torn down with the
   *  old registry, so a workflow that kept ticking would launch fresh nodes nothing can reach or abort, and
   *  its durable row would claim `running` for ever. Make the boundary terminal instead — including
   *  BACKGROUND workflows, which normally outlive an abort: sparing one here would only orphan it. */
  ctx.registerHook?.({
    name: 'plugin.reload.before',
    run: () => {
      for (const wf of workflows.values()) {
        if (!wf.finished) cancelWorkflow(wf);
      }
    },
  });

  ctx.registerTool(defineTool({
    name: 'WorkflowStart', label: 'Run a workflow',
    description: [
      `Run a DAG of sub-agents whose complete definition lives in a JSON file. Before calling this tool, use Write to create that file, then pass its path as nodesFile. Do not pass nodes inline. When your session has unrestricted filesystem access, write it under ${workflowDir} (it already exists) so the run leaves nothing behind in the user's project. A project-scoped session cannot write there and must use a path inside an accessible repository — which is also the right choice for a definition you want to keep and version.`,
      'The file may contain either a JSON array of node objects, or an object shaped as { title?, fork?, nodes: [...], background? }. Explicit title, fork, or background tool arguments override the corresponding values from the file, so one file can be reused as a template.',
      'Each node requires a short unique string id and a complete self-contained string task. Optional fields are deps, model, thinkingLevel, fork, read_only, tools, subagent_type, and workspaceId. thinkingLevel sets that node\'s reasoning effort — omit it (or keep it low) for mechanical nodes, raise it for a node that has to design, debug something unexplained or review security-sensitive work; omitted, the node inherits your own. WorkflowStart.workspaceId sets the default explicit Sandbox workspace; a node workspaceId may only preserve or narrow its effective parent scope. At least one node must have no deps. Each node is a fresh sub-agent that cannot see this conversation, so put everything it needs in its task — unless you set fork, which starts it from this conversation\'s own prompt, tools and history.',
      'Use a workflow instead of several separate delegate calls when the subtasks have an ORDER or dependency between them (gather → analyze → write), or when a later step needs earlier steps\' results. Independent nodes run in parallel, and a dependent receives a short handover from each of its DIRECT dependencies (not their full results, and nothing from further upstream) — so a node whose task needs an earlier finding must be reachable from it through the deps chain. For fully independent tasks, plain parallel delegate calls are simpler.',
      'By default the call BLOCKS and returns every node\'s result. Set background=true (in the file or as an explicit argument) to return a handle immediately and receive the summary in a NEW turn. A node whose dependency failed is reported as skipped.',
      'If the result names failed or skipped nodes and the workflow is still held in memory, use WorkflowResume instead of starting over — it re-runs only unfinished nodes and leaves every completed node unchanged.',
    ].join(' '),
    parameters: Type.Object({
      nodesFile: Type.String({ description: `Path to the JSON workflow definition. Create it with Write first — under ${workflowDir} for a one-off run if your session may write there, otherwise inside an accessible repository. Pass either a node array or { title?, fork?, nodes, background? }.` }),
      title: Type.Optional(Type.String({ description: 'Override the file\'s title. Human label shown in the CLI panel: AT MOST 4 WORDS, in the user\'s language, no trailing punctuation (the UI appends an ellipsis).' })),
      fork: Type.Optional(Type.Boolean({ description: 'Default for every node that does not set `fork` itself. On, each node starts from THIS conversation\'s prompt, tools and history instead of a clean context; a node may still override it. Overrides the file\'s own `fork` field.' })),
      background: Type.Optional(Type.Boolean({ description: 'Override the file\'s background setting. True starts asynchronously and delivers the summary in a NEW turn; false blocks until completion.' })),
      workspaceId: Type.Optional(Type.String({ minLength: 1, description: 'Default explicit Sandbox workspace for workflow nodes. Omit for legacy project-scope behavior; an active workspace binding is not inherited as the logical root, but nodes spawned from a bound conversation still start in that worktree, where shell commands whose working directory is inside the workspace run in the workspace container, and a read_only node has no Write tool and no scratch directory there, so it must return its plan or document as its node result.' })),
    }),
    execute: async (toolCallId, p) => {
      if (!getRun()) return ok('Error: workflows are not wired up on this server.');
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      if (!originSessionId || !originPrincipal) return ok('Error: workflows run only inside an authenticated conversation.');
      let source;
      try {
        const path = ctx.assertPathAllowed(p.nodesFile);
        source = JSON.parse(readFileSync(path, 'utf8'));
      } catch (e) {
        const message = ctx.sanitizePathOutput(errorText(e));
        if (e instanceof SyntaxError) {
          return ok(`Error: workflow file "${p.nodesFile}" contains invalid JSON (${message}). Fix the JSON syntax in the file, then call WorkflowStart again.`);
        }
        return ok(`Error: cannot read workflow file "${p.nodesFile}": ${message}. Create or correct the file inside an accessible repository, then call WorkflowStart again.`);
      }
      let rawNodes;
      let fileOptions = {};
      if (Array.isArray(source)) rawNodes = source;
      else if (isRecord(source) && Array.isArray(source.nodes)) {
        rawNodes = source.nodes;
        fileOptions = source;
      } else {
        return ok(`Error: workflow file "${p.nodesFile}" must contain a JSON array of nodes or an object with a "nodes" array. Rewrite the file in one of those two forms, then call WorkflowStart again.`);
      }
      // RETIRED: a file-wide `context` block handed to every node. Forking replaced it — a node that needs
      // what the origin conversation knows inherits the whole of it, cache included, instead of a budgeted
      // excerpt. Named explicitly so an existing template says what to do rather than silently losing text.
      if (fileOptions.context !== undefined) {
        return ok(`Error: workflow file "${p.nodesFile}" still carries a shared "context" field. That hand-over was replaced by forking: set "fork": true on the workflow or on the nodes that need this conversation's context, and put anything else into each node's own task.`);
      }
      for (const [field, type] of [['title', 'string'], ['fork', 'boolean'], ['background', 'boolean']]) {
        if (fileOptions[field] !== undefined && typeof fileOptions[field] !== type) {
          return ok(`Error: workflow file "${p.nodesFile}" field "${field}" must be a ${type}. Fix or remove that field, then call WorkflowStart again.`);
        }
      }
      const { nodes: validatedNodes, error, index } = validateWorkflowNodes(rawNodes);
      if (error) return ok(`Error: workflow file "${p.nodesFile}": ${actionableNodeError(rawNodes, error, index)}.`);
      // Resolved before the node pass below, which applies it to every node that stayed silent.
      const forkDefault = p.fork !== undefined ? p.fork === true : fileOptions.fork === true;
      let parentAccess = ctx.currentAccess();
      let workspaceRef;
      let nodes;
      try {
        workspaceRef = resolveWorkspaceRef(parentAccess, p.workspaceId);
        parentAccess = workspaceRef ? { ...parentAccess, workspaceRef } : parentAccess;
        // The file-level default applies only where a node stayed silent, so a per-node `fork` always wins.
        // A node that narrows itself is left alone: dag.mjs refuses the pair, and a blanket default must
        // not turn a deliberately read-only node into a rejected workflow.
        const withFork = forkDefault
          ? validatedNodes.map((n) => (n.fork || n.tools || n.readOnly || n.subagentType || n.workspaceId
            ? n : { ...n, fork: true }))
          : validatedNodes;
        nodes = resolveNodeWorkspaces(withFork, parentAccess, workspaceRef);
      } catch (e) {
        return ok(`Error: ${errorText(e)}.`);
      }
      const title = p.title !== undefined ? p.title : fileOptions.title;
      const background = p.background !== undefined ? p.background : fileOptions.background;
      pruneWorkflows();
      // Only UNFINISHED workflows compete for the slot — a finished one sitting in memory for retention
      // is not "running" and must never block a new start (that was the bug: 16 quickly-finished
      // workflows locked the tool out for an hour even with nothing actually in flight).
      const runningCount = [...workflows.values()].filter((wf) => wf.finishedAt === undefined).length;
      if (runningCount >= MAX_WORKFLOWS) return ok(`Error: too many workflows (${MAX_WORKFLOWS}) are running; wait for one to finish.`);
      // Capture the durable completion sink on the ORIGIN turn, before any node is scheduled — node turns
      // run in their own scope where this accessor no longer resolves to this conversation.
      const emitCompletion = ctx.workflowCompletionEmitter?.() ?? undefined;
      const wf = {
        id: `wf-${randomUUID()}`,
        // THIS call — the origin's WorkflowStart. Every snapshot names it, so the host can persist the
        // DAG against the transcript row this call produced (mirrors delegate's `toolCallId`).
        toolCallId,
        title: typeof title === 'string' ? decodeUnicodeEscapes(title.trim()).slice(0, 200) || undefined : undefined,
        status: 'running',
        nodes,
        state: new Map(nodes.map((n) => [n.id, freshNodeState()])),
        // Only dynamically child-added nodes enter these maps; originals and origin-added nodes use the parent.
        nodeParentAccess: new Map(),
        nodeParentModel: new Map(),
        parentAccess,
        parentModel: ctx.currentModel() ?? undefined,
        ...(workspaceRef ? { workspaceRef } : {}),
        // The origin turn's working directory, inherited by every node so a node's tools resolve against
        // the SAME project the workflow was launched in, never the daemon's `/`.
        parentCwd: workspaceRef || parentAccess.workspaceRef ? undefined : ctx.currentWorkDir?.(),
        emit: ctx.workflowEmitter(),
        originSessionId,
        originPrincipal,
        // Abort one of this workflow's node children through the host. The host authorizes a stop against
        // the turn on the async-context stack, and every node child is registered under `originSessionId`
        // — but the engine keeps launching nodes long after the origin turn returned, and a self-expansion
        // (WorkflowAddNodes) ticks under a NODE's turn, so an ambient stop is scoped to a session that
        // does not own the child and is refused, leaving it running unsupervised. Everything else the
        // engine needs from the origin turn is captured here as a value; this is the one call that has to
        // be MADE in it, so it is bound to the origin's async context rather than the caller's. This
        // widens nothing: it can only reach the origin's own children, exactly as WorkflowStop already
        // does from the origin turn itself.
        stopChild: AsyncResource.bind((sessionId) => ctx.stopSubagent?.(sessionId)),
        childSessions: new Set(),
        finished: false,
        finishedAt: undefined,
        resolveDone: undefined,
        // A detach (Ctrl+B) or explicit background flips this on; foreground and background share ONE run.
        background: background === true,
        emitCompletion,
        resolveDetached: undefined,
      };
      workflows.set(wf.id, wf);
      writeJournal(wf);
      // Start the DAG once. This promise settles the terminal status, finishes the row and yields the
      // summary — a foreground blocking call and a detach/background call ride this SAME run.
      const completion = runToCompletion(wf).catch((e) => {
        wf.status = 'error';
        wf.finished = true;
        wf.finishedAt = Date.now();
        return `Error: workflow failed: ${errorText(e)}`;
      });

      // Foreground blocks on the DAG but lets Ctrl+B detach the wait; background returns the handle right
      // away — driveResult is the shared tail WorkflowResume reuses so both behave identically.
      return driveResult(wf, completion, background === true);
    },
  }), { hostFilesystem: true });

  ctx.registerTool(defineTool({
    name: 'WorkflowResume', label: 'Resume a workflow',
    description: 'Re-run only the UNFINISHED nodes of a workflow that already stopped — one whose result named '
      + 'failed or skipped nodes, or one you had to interrupt. Nodes that already finished (DONE) are left '
      + 'exactly as they are and are NOT re-run; their results still feed the nodes that depend on them, '
      + 'exactly as in the original run. Everything else (ERROR, or PENDING because a dependency failed) is '
      + 'retried — and a node that had already STARTED resumes inside its own child session, so it still sees '
      + 'the work it did before the interruption and is told to carry on from there rather than repeat it. A '
      + 'node that never launched has no session to resume into and starts clean. '
      + 'Behaves exactly like WorkflowStart otherwise — same blocking/background choice, '
      + 'same live snapshot, same final summary — because it IS the same run continuing.\n\n'
      + 'This only works while the workflow is still held in memory on this daemon: a workflow older than an '
      + 'hour, or evicted because too many others ran since, or from before a daemon restart, cannot be '
      + 'resumed — start a fresh WorkflowStart instead, most likely against a worktree that already carries '
      + 'the DONE nodes\' completed work.',
    parameters: Type.Object({
      workflowId: Type.String({ description: 'The id of the finished workflow to resume (from WorkflowStart / WorkflowStatus).' }),
      background: Type.Optional(Type.Boolean({ description: 'Override whether the resumed run is foreground or background. Omit to keep whatever the original run was.' })),
    }),
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      // `authWorkflow` also accepts one of the workflow's OWN node sessions. That is right for
      // WorkflowAddNodes — self-expansion runs under the boundary the child already holds — but wrong
      // here: resume relaunches nodes under the workflow's PARENT access, so a node deliberately given a
      // narrow toolset could use it to run sibling work it may not perform itself. Resume is the origin's
      // to call.
      if (!wf || ctx.currentSessionId() !== wf.originSessionId) {
        return ok(`Error: no workflow ${p.workflowId} you can resume — it may have finished too long ago, been evicted from memory, or belong to another conversation. A workflow can only be resumed from the conversation that started it.`);
      }
      if (!wf.finished) return ok(`Error: workflow ${wf.id} is still running; there is nothing to resume yet.`);
      const unfinished = wf.nodes.filter((n) => wf.state.get(n.id).status !== 'done');
      if (!unfinished.length) return ok(`Error: every node in workflow ${wf.id} already finished; there is nothing to resume.`);
      // The access boundary this resume will run under. It is re-captured (rather than replayed from the
      // start) because it may since have been narrowed — a project revoked, tools disabled, permissions
      // tightened, the conversation put in plan/read-only mode — and replaying the old one would execute
      // authority the caller no longer holds, which is exactly what delegated continuation refuses to do
      // elsewhere.
      const access = ctx.currentAccess();
      // A node's child session is pinned to the boundary it was minted under and the host demands an EXACT
      // match to respawn it, so any change to the boundary — not only a narrowing — makes the old channel
      // unusable: the respawn is refused with `delegated access unavailable` and the resume dies inside the
      // node rather than here. Start those nodes in a FRESH channel instead — the run continues, at the
      // honest cost of the earlier session's transcript, which they repeat rather than build on.
      const scopeChanged = !sameParentAccess(wf.parentAccess, access);
      // A child-added node is permanently bounded by the adding child's narrower authority. If the origin's
      // own boundary also changed, there is no safe general intersection for ordered permission rules; refuse
      // rather than replay either stale authority or a widened node under the new parent.
      if (scopeChanged && unfinished.some((node) => wf.nodeParentAccess.has(node.id))) {
        return ok(`Error: workflow ${wf.id} has unfinished dynamically added nodes and the origin access boundary has changed. Start a new workflow under the current access instead of replaying stale child authority.`);
      }
      // Reset the run-scoped fields, but carry the channel id of a node that ACTUALLY RAN across: that is
      // what lets it resume inside its own session instead of repeating work it already did. A node holds a
      // session only once it started, so a PENDING one (never launched, or skipped because a dependency
      // failed) keeps a clean slate and starts from nothing, exactly as before.
      //
      // Losing the channel does NOT make a node that ran a clean-slate one: it is told about its earlier
      // attempt either way, only in the terms it can act on — its own transcript when it kept the session,
      // the state left on disk when it did not.
      for (const n of unfinished) {
        const prev = wf.state.get(n.id);
        const next = freshNodeState();
        if (prev?.sessionId) {
          if (!scopeChanged && prev.channelId) { next.channelId = prev.channelId; next.taskNote = RESUME_NOTE; }
          else next.taskNote = RESTART_NOTE;
        }
        wf.state.set(n.id, next);
      }
      if (typeof p.background === 'boolean') wf.background = p.background;
      wf.finished = false;
      wf.finishedAt = undefined;
      wf.run = (wf.run ?? 0) + 1;
      // Re-capture BOTH turn-scoped emitters on THIS (resuming) turn, exactly like WorkflowStart does —
      // the ones captured at the original Start are bound to a turn that is long over.
      wf.emit = ctx.workflowEmitter();
      wf.emitCompletion = ctx.workflowCompletionEmitter?.() ?? undefined;
      wf.parentAccess = access;
      writeJournal(wf); // the finish deleted the journal; the resumed run is interruptible again
      const completion = runToCompletion(wf).catch((e) => {
        wf.status = 'error';
        wf.finished = true;
        wf.finishedAt = Date.now();
        return `Error: workflow failed: ${errorText(e)}`;
      });
      const res = await driveResult(wf, completion, wf.background === true);
      if (!scopeChanged) return res;
      return ok(
        'Note: your access boundary has changed since this workflow started, so the unfinished nodes could '
        + 'not re-enter the sessions they ran in before — they started clean under your current access and '
        + `repeated any work they had already done.\n\n${res.content[0].text}`,
        res.details,
      );
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowAddNodes', label: 'Extend a workflow',
    description: 'Add nodes to a workflow that is ALREADY RUNNING — dynamic expansion, so a DAG can grow as '
      + 'the work reveals more work. Use it from inside a node sub-agent when what you just found needs '
      + 'follow-up steps the original plan did not have; to start a new DAG use WorkflowStart, and to '
      + 're-run the unfinished nodes of one that already stopped use WorkflowResume. Each new node needs a '
      + 'unique id and a complete self-contained task, may depend on existing or new nodes through `deps`, '
      + 'and must not create a cycle — a duplicate id, an unknown dependency or a cycle is rejected and '
      + 'nothing is added. A node added by a child inherits that child\'s narrower access and can never '
      + 'widen it, and a workflow that has already finished or been evicted from memory cannot be '
      + 'extended. Returns which node ids were added; the new nodes start as soon as their dependencies '
      + 'allow it, and they are part of the workflow\'s own result, not a separate one you collect.',
    parameters: Type.Object({
      workflowId: Type.String({ description: 'The id of the RUNNING workflow to extend — from WorkflowStart, WorkflowStatus, or the briefing of the node you are running as.' }),
      fork: Type.Optional(Type.Boolean({ description: 'Default for every added node that does not set `fork` itself. On, each starts from the workflow\'s ORIGIN conversation — its prompt, tools and history — instead of a clean context.' })),
      workspaceId: Type.Optional(Type.String({ minLength: 1, description: 'Default explicit Sandbox workspace for every added node that does not declare its own workspaceId.' })),
      nodes: Type.Array(NODE_SHAPE, { description: 'The nodes to add: each with a new unique id, a self-contained task, and optional deps on existing or newly added node ids (no cycles).' }),
    }),
    // `_id` is THIS call's tool id, and this tool usually runs inside a NODE's own turn. It is
    // deliberately unused: the snapshot must address the origin's WorkflowStart row, which `snapshot()`
    // reads off wf.toolCallId. Keying anything here off `_id` would fork a phantom row per expansion.
    execute: async (_id, p) => {
      try {
        // A runner's plugin instance owns no DAG. Its host bridge carries only the requested workflow id and
        // nodes; the daemon independently derives the caller session and performs this same mutation there.
        const local = authWorkflow(p.workflowId);
        const rpc = ctx.workflowExpansionRpc?.();
        // A runner may itself own a NESTED workflow started by one of its turns. Prefer that local DAG;
        // only an id absent from this process crosses upward to the daemon-owned parent workflow.
        const withWorkspace = p.workspaceId
          ? p.nodes.map((node) => node.workspaceId ? node : { ...node, workspaceId: p.workspaceId })
          : p.nodes;
        // The call-level default applies only where a node stayed silent, and never to one that narrows
        // itself — dag.mjs refuses that pair, and a blanket default must not reject the caller's own node.
        const nodes = p.fork
          ? withWorkspace.map((node) => (node.fork || node.tools || node.read_only || node.subagent_type || node.workspaceId
            ? node : { ...node, fork: true }))
          : withWorkspace;
        let result;
        if (local) result = addNodesFromSession(p.workflowId, nodes, undefined, ctx.currentAccess(), ctx.currentModel());
        else if (rpc) result = await rpc.addNodes({ workflowId: p.workflowId, nodes });
        else result = addNodesFromSession(p.workflowId, nodes, undefined, ctx.currentAccess(), ctx.currentModel());
        return ok(`Added ${result.added.length} node(s) to workflow ${p.workflowId}: ${result.added.join(', ')}.`);
      } catch (e) {
        return ok(`Error: ${errorText(e)}.`);
      }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowStatus', label: 'Check a workflow',
    description: 'Return a live snapshot of one workflow DAG: its overall status plus, for every node, its '
      + 'id, current status (pending, running, done, error, skipped), the nodes it depends on and how much '
      + 'it has spent so far in tokens and seconds. It is a one-off view for when the user asks how a '
      + 'workflow is going, or when you need a node id before WorkflowAddNodes or WorkflowResume. A '
      + 'foreground WorkflowStart already blocks and returns the full result, and a background one '
      + 'delivers its summary to you in a NEW turn — so you never need this to collect results, and '
      + 'polling it in a loop is never the answer. It returns node STATUS plus, for a failed node, a short '
      + 'reason it failed — never a successful node\'s output text — and it changes nothing: to end a run '
      + 'early use WorkflowStop. Workflows live in memory on '
      + 'this daemon, so one that expired, was evicted, ran before a restart, or belongs to another '
      + 'conversation is reported as unknown.',
    parameters: Type.Object({ workflowId: Type.String({ description: 'The workflow id returned by WorkflowStart (e.g. "wf-…").' }) }),
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      if (!wf) return ok(`Error: no workflow ${p.workflowId}, or it has expired.`);
      const lines = [`Workflow ${wf.id}${wf.title ? ` "${wf.title}"` : ''}: ${wf.status}`];
      for (const n of wf.nodes) {
        const s = wf.state.get(n.id);
        lines.push(`- [${n.id}] ${s.status}${n.deps.length ? ` (deps: ${n.deps.join(', ')})` : ''}`
          + `${s.tokens !== undefined ? ` · ${s.tokens} tok` : ''}${s.seconds !== undefined ? ` · ${s.seconds}s` : ''}`
          + `${s.detail ? ` · ${s.detail}` : ''}`
          // A bare "error" is unactionable: the caller cannot tell a bad task from a provider refusal, and
          // the reason (a 400 body, a rejected model, a cancelled spawn) is already stored. One bounded
          // single line of it — this is still a STATUS view, not the node's output.
          // Collapsed AFTER the clip: TRUNCATION_MARKER itself starts with a newline, which would split the
          // entry across two lines of the joined listing.
          + `${s.status === 'error' && s.error ? ` · ${clip(s.error, STATUS_ERROR_PREVIEW).replace(/\s+/g, ' ').trim()}` : ''}`);
      }
      return ok(lines.join('\n'), { workflowId: wf.id, status: wf.status });
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowStop', label: 'Stop a workflow',
    description: 'Stop a workflow that is still running — the only way to end a BACKGROUND one early. A '
      + 'background workflow (background=true, or a Ctrl+B detach) deliberately survives every abort of the '
      + 'conversation that started it, so Esc-Esc does not reach it; call this when the user asks to stop it, '
      + 'when it is working on something no longer wanted, or when a node is stuck. The engine stops '
      + 'launching further nodes and the node sub-agents still running are aborted. Nodes that already '
      + 'finished keep their results, so WorkflowResume can pick the workflow back up while it is still held '
      + 'in memory. Resolves "nothing to stop" rather than erroring when it has already finished.',
    parameters: Type.Object({
      workflowId: Type.String({ description: 'The id of the running workflow (from WorkflowStart / WorkflowStatus).' }),
    }),
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      // Origin-only, exactly like WorkflowResume: `authWorkflow` also accepts one of the workflow's own
      // node sessions (right for self-expansion), but a node must not be able to tear down the run it and
      // its siblings live in.
      if (!wf || ctx.currentSessionId() !== wf.originSessionId) {
        return ok(`Error: no workflow ${p.workflowId} you can stop — it may have finished too long ago, been evicted from memory, or belong to another conversation. A workflow can only be stopped from the conversation that started it.`);
      }
      if (wf.finished) return ok(`Nothing to stop — workflow ${wf.id} already finished (${wf.status}).`);
      const running = [];
      for (const node of wf.nodes) {
        const s = wf.state.get(node.id);
        if (s?.status === 'running' && s.sessionId) running.push({ id: node.id, sessionId: s.sessionId });
      }
      // Stop the ENGINE before the children, or it relaunches the next ready node the moment an aborted
      // one settles — the same order the host's own delegated teardown uses.
      cancelWorkflow(wf);
      let stopped = 0;
      for (const node of running) {
        try {
          const res = await wf.stopChild(node.sessionId);
          if (res?.stopped) stopped += 1;
        } catch (e) {
          // The DAG is already stopped; a child that cannot be aborted (already settled, unwired host) is
          // reported in the count, not raised as a failure of the stop itself.
          ctx.logger.warn(`workflow ${wf.id}: node "${node.id}" could not be aborted: ${errorText(e)}`);
        }
      }
      return ok(
        `Stopped workflow ${wf.id}. ${stopped} of ${running.length} running node(s) aborted; `
        + 'finished nodes keep their results, so WorkflowResume can still pick it up.',
        { workflowId: wf.id, status: 'cancelled', stopped },
      );
    },
  }));

  ctx.logger.info('workflow tools registered (start/resume/stop/add_nodes/status)');
}
