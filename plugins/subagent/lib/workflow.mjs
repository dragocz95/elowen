// Workflow engine: runs a declarative DAG of sub-agents. Each node is spawned through the SAME host
// `run` handler the `delegate` tool uses (System 1 in-process PI sessions — never Orca/overseer), so a
// node inherits the caller's access/model and its usage rolls up to the originating conversation. The
// engine holds the DAG in memory (like delegate's background jobs) and streams the whole snapshot to the
// parent's clients as `workflow` events on every state change. It does NOT emit `subagent` events, so a
// workflow node never doubles up in the flat sub-agent panel.
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { validateWorkflowNodes, mergeWorkflowNodes, readyNodeIds } from './dag.mjs';

const MAX_WORKFLOWS = 16;
const WORKFLOW_RETENTION_MS = 60 * 60_000;
const MAX_RESULT_CHARS = 8_000;
// The workflow snapshot re-emits every node on each state change; the UI only previews a node's task, so
// the snapshot carries at most this many chars of it (the full task still drives the child's turn).
const SNAPSHOT_TASK_PREVIEW = 500;

const ok = (text, details = {}) => ({ content: [{ type: 'text', text }], details });
const errorText = (e) => (e instanceof Error ? e.message : String(e));
const clip = (text, limit) => (text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`);

// The node-declaration shape shared by WorkflowStart and WorkflowAddNodes.
const NODE_SHAPE = Type.Object({
  id: Type.String({ description: 'Short unique id for this node (referenced by other nodes\' deps).' }),
  task: Type.String({ description: 'The complete, self-contained instruction for this node\'s sub-agent — it cannot see the conversation.' }),
  deps: Type.Optional(Type.Array(Type.String(), { description: 'Ids of nodes that must finish before this one starts. Omit for a root node.' })),
  model: Type.Optional(Type.String({ description: 'Run this node on a DIFFERENT model (value from DelegateModels). Omit to inherit yours.' })),
  read_only: Type.Optional(Type.Boolean({ description: 'Give this node only read-only tools (explore/report, no writing or delegation).' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Give this node EXACTLY these tools (names from your own toolset). Narrows only.' })),
});

/** Register the workflow tools on the subagent plugin. `getRun` returns the host channel handler once
 *  connected; `helpers` are the delegate primitives reused verbatim so node spawning matches delegation
 *  exactly (same narrowing invariant, same principal check, same context chunking). */
export function registerWorkflow(ctx, getRun, { resolveDelegateTools, principalOf, delegateContextChunk }) {
  /** id -> workflow. In-memory only (mirrors delegate's `jobs`): a workflow does not survive a daemon
   *  restart, and its node child sessions persist on their own. */
  const workflows = new Map();

  const freshNodeState = () => ({ status: 'pending', sessionId: '', tools: 0, detail: undefined, tokens: undefined, seconds: undefined, model: undefined, startedAt: undefined, result: undefined, error: undefined });

  const statusMap = (wf) => {
    const map = {};
    for (const [id, s] of wf.state) map[id] = s.status;
    return map;
  };

  const pruneWorkflows = (now = Date.now()) => {
    for (const [id, wf] of workflows) {
      if (wf.finishedAt !== undefined && now - wf.finishedAt >= WORKFLOW_RETENTION_MS) workflows.delete(id);
    }
  };

  /** Resolve a workflow the CURRENT turn is allowed to see/extend. Two authorized callers, fail closed:
   *   - one of the workflow's OWN node child sessions (self-expansion). A delegated node turn always runs
   *     as the anonymous `subagent:subagent` principal (identity.forDelegatedTurn), so its principal can
   *     never match the origin's — membership in `childSessions` is the authorization here, and it is
   *     unforgeable: a session lands there only via THIS workflow's own node `session` events.
   *   - the ORIGIN session itself, which must carry the same real principal that started the workflow. */
  const authWorkflow = (id) => {
    const wf = workflows.get(id);
    if (!wf) return undefined;
    const sessionId = ctx.currentSessionId();
    if (!sessionId) return undefined;
    if (wf.childSessions.has(sessionId)) return wf;
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
        ...(s.sessionId ? { sessionId: s.sessionId } : {}),
        ...(s.detail ? { detail: s.detail } : {}),
        ...(s.tokens !== undefined ? { tokens: s.tokens } : {}),
        ...(s.seconds !== undefined ? { seconds: s.seconds } : {}),
        ...(n.model ? { model: n.model } : {}),
      };
    });
    // Always the ORIGIN's WorkflowStart call, never whatever tool call is executing right now: a node's
    // own turn can trigger a snapshot (WorkflowAddNodes), and it must still land on the origin's row.
    try { wf.emit({ id: wf.id, toolCallId: wf.toolCallId, ...(wf.title ? { title: wf.title } : {}), status: wf.status, nodes }); }
    catch (e) { ctx.logger.warn(`workflow snapshot fan-out failed: ${errorText(e)}`); }
  };

  /** Build one node's access from the captured parent scope + the node's own model/tool narrowing —
   *  mirrors the `delegate` access assembly exactly (can only ever narrow the parent). May reject. */
  const buildNodeAccess = async (wf, node) => {
    let model = wf.parentModel ?? undefined;
    if (node.model) {
      const list = await ctx.listModels().catch(() => []);
      const hit = list.find((m) => `${m.provider}/${m.model}` === node.model || m.model === node.model);
      if (!hit) throw new Error(`model "${node.model}" is not available for node "${node.id}"`);
      model = { provider: hit.provider, model: hit.model };
    }
    const restricted = resolveDelegateTools(wf.parentAccess.toolPolicy?.allow, node.readOnly, node.tools, ctx.toolNames());
    if (restricted.error) throw new Error(restricted.error);
    const toolPolicy = restricted.allow
      ? { ...(wf.parentAccess.toolPolicy?.deny ? { deny: wf.parentAccess.toolPolicy.deny } : {}), allow: restricted.allow }
      : wf.parentAccess.toolPolicy;
    // A node that keeps full access (no read_only, no explicit toolset) may extend the DAG; a narrowed
    // node cannot (it may not even hold WorkflowAddNodes), so it is never invited to.
    const canExpand = !node.readOnly && !node.tools;
    const contextParts = [];
    if (canExpand) {
      contextParts.push(`You are node "${node.id}" of a running workflow (id "${wf.id}"). Only if completing this `
        + `task clearly reveals concrete follow-up sub-tasks, you may call WorkflowAddNodes with that workflowId `
        + `to add them; otherwise just finish your task and report.`);
    }
    if (wf.sharedContext) contextParts.push(wf.sharedContext);
    const context = contextParts.length ? delegateContextChunk(contextParts.join('\n\n')) : undefined;
    return {
      ...wf.parentAccess,
      ...(toolPolicy ? { toolPolicy } : {}),
      model,
      parentSessionId: wf.originSessionId,
      // In-memory host object; never serialized (Infinity would become null in JSON) — keeps the node
      // transcript pinned to this workflow instead of rolling over mid-run.
      sessionIdleMs: Infinity,
      prompt: 'You are a focused sub-agent running one node of a workflow. Complete the task and report the result concisely — no preamble.',
      ...(context ? { context } : {}),
    };
  };

  const runNode = async (wf, node) => {
    const ns = wf.state.get(node.id);
    ns.startedAt = ns.startedAt ?? Date.now();
    const onEvent = (e) => {
      if (e.type === 'session' && e.sessionId) { ns.sessionId = e.sessionId; wf.childSessions.add(e.sessionId); snapshot(wf); }
      else if (e.type === 'tool' && e.name) { ns.tools += 1; ns.detail = e.detail ? `${e.name} ${e.detail}` : e.name; ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000); snapshot(wf); }
      else if ((e.type === 'step' || e.type === 'idle') && e.usage?.totalTokens) { ns.tokens = e.usage.totalTokens; ns.seconds = Math.round((Date.now() - ns.startedAt) / 1000); snapshot(wf); }
    };
    try {
      const access = await buildNodeAccess(wf, node);
      const channelId = `wf-${wf.id}-${node.id}-${randomUUID()}`;
      const collectSource = { platform: 'subagent', userId: 'subagent', roleIds: [], channelId, access };
      const raw = await getRun()(collectSource, node.task, onEvent);
      const reply = raw || '(the node returned nothing)';
      if (reply.startsWith('Error:')) { ns.status = 'error'; ns.error = clip(reply.slice('Error:'.length).trim() || reply, MAX_RESULT_CHARS); }
      else { ns.status = 'done'; ns.result = clip(reply, MAX_RESULT_CHARS); }
    } catch (e) {
      ns.status = 'error';
      ns.error = clip(errorText(e), MAX_RESULT_CHARS);
    }
    ns.seconds = Math.round((Date.now() - (ns.startedAt ?? Date.now())) / 1000);
    snapshot(wf);
    tick(wf);
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
      else lines.push('(did not run — a dependency failed)');
    }
    return lines.join('\n');
  };

  const runWorkflow = async (wf) => {
    wf.status = 'running';
    snapshot(wf);
    await new Promise((resolve) => { wf.resolveDone = resolve; tick(wf); });
    wf.status = [...wf.state.values()].some((s) => s.status === 'error') ? 'error' : 'done';
    snapshot(wf);
    return summarize(wf);
  };

  ctx.registerTool(defineTool({
    name: 'WorkflowStart', label: 'Run a workflow',
    description: [
      'Run a DAG of sub-agents: you declare nodes (each a self-contained task) and their dependencies, and the engine executes them as dependencies clear — independent nodes run in parallel, dependents wait for what they need. Each node is a fresh sub-agent that inherits your access; it cannot see this conversation, so every task must be complete and standalone.',
      'Use a workflow instead of several separate delegate calls when the subtasks have an ORDER or dependency between them (gather → analyze → write), or when a later step needs earlier steps\' results. For a set of fully independent tasks, plain parallel delegate calls are simpler.',
      'The call BLOCKS and returns a summary of every node\'s result once the whole workflow finishes. A node whose dependency failed is reported as skipped. Give each node a short unique id and list its dependency ids in deps. Use read_only/tools/model per node exactly as with delegate — you can only ever narrow your own access.',
    ].join(' '),
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: 'Short human label for the workflow (shown in the CLI panel).' })),
      context: Type.Optional(Type.String({ description: 'Background shared by ALL nodes (added to each node\'s cache-friendly system prefix) — findings, conventions, ids they would otherwise re-derive.' })),
      nodes: Type.Array(NODE_SHAPE, { description: 'The workflow nodes. At least one must have no deps (a root).' }),
    }),
    execute: async (toolCallId, p) => {
      if (!getRun()) return ok('Error: workflows are not wired up on this server.');
      const originSessionId = ctx.currentSessionId();
      const originPrincipal = principalOf(ctx.currentIdentity());
      if (!originSessionId || !originPrincipal) return ok('Error: workflows run only inside an authenticated conversation.');
      const { nodes, error } = validateWorkflowNodes(p.nodes);
      if (error) return ok(`Error: ${error}`);
      pruneWorkflows();
      if (workflows.size >= MAX_WORKFLOWS) return ok(`Error: too many workflows (${MAX_WORKFLOWS}) are running; wait for one to finish.`);
      const wf = {
        id: `wf-${randomUUID()}`,
        // THIS call — the origin's WorkflowStart. Every snapshot names it, so the host can persist the
        // DAG against the transcript row this call produced (mirrors delegate's `toolCallId`).
        toolCallId,
        title: typeof p.title === 'string' ? p.title.trim().slice(0, 200) || undefined : undefined,
        status: 'running',
        nodes,
        state: new Map(nodes.map((n) => [n.id, freshNodeState()])),
        parentAccess: ctx.currentAccess(),
        parentModel: ctx.currentModel() ?? undefined,
        emit: ctx.workflowEmitter(),
        sharedContext: typeof p.context === 'string' && p.context.trim() ? p.context.trim() : undefined,
        originSessionId,
        originPrincipal,
        childSessions: new Set(),
        finished: false,
        finishedAt: undefined,
        resolveDone: undefined,
      };
      workflows.set(wf.id, wf);
      try {
        return ok(await runWorkflow(wf));
      } catch (e) {
        return ok(`Error: workflow failed: ${errorText(e)}`);
      } finally {
        wf.finished = true;
        wf.finishedAt = Date.now();
      }
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowAddNodes', label: 'Extend a workflow',
    description: 'Add nodes to a workflow that is already running (dynamic expansion). New node ids must be '
      + 'unique, may depend on existing or new nodes, and must not create a cycle. Available to the node '
      + 'sub-agents themselves so a workflow can grow as work reveals more work. Returns which nodes were added.',
    parameters: Type.Object({
      workflowId: Type.String({ description: 'The id of the running workflow (from WorkflowStart / your node briefing).' }),
      nodes: Type.Array(NODE_SHAPE, { description: 'The nodes to add.' }),
    }),
    // `_id` is THIS call's tool id, and this tool usually runs inside a NODE's own turn. It is
    // deliberately unused: the snapshot must address the origin's WorkflowStart row, which `snapshot()`
    // reads off wf.toolCallId. Keying anything here off `_id` would fork a phantom row per expansion.
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      if (!wf) return ok(`Error: no running workflow ${p.workflowId} you can extend.`);
      if (wf.finished) return ok(`Error: workflow ${p.workflowId} has already finished; start a new one.`);
      const { nodes, error } = mergeWorkflowNodes(wf.nodes, p.nodes);
      if (error) return ok(`Error: ${error}`);
      for (const n of nodes) { wf.nodes.push(n); wf.state.set(n.id, freshNodeState()); }
      snapshot(wf);
      tick(wf);
      return ok(`Added ${nodes.length} node(s) to workflow ${wf.id}: ${nodes.map((n) => n.id).join(', ')}.`);
    },
  }));

  ctx.registerTool(defineTool({
    name: 'WorkflowStatus', label: 'Check a workflow',
    description: 'Return a snapshot of a workflow: each node\'s status, dependencies and progress. A one-off '
      + 'view for when the user asks how it is going — WorkflowStart already blocks until the whole workflow '
      + 'is done and returns the full result, so you do not need this to collect results.',
    parameters: Type.Object({ workflowId: Type.String({ description: 'The workflow id from WorkflowStart.' }) }),
    execute: async (_id, p) => {
      const wf = authWorkflow(p.workflowId);
      if (!wf) return ok(`Error: no workflow ${p.workflowId}, or it has expired.`);
      const lines = [`Workflow ${wf.id}${wf.title ? ` "${wf.title}"` : ''}: ${wf.status}`];
      for (const n of wf.nodes) {
        const s = wf.state.get(n.id);
        lines.push(`- [${n.id}] ${s.status}${n.deps.length ? ` (deps: ${n.deps.join(', ')})` : ''}`
          + `${s.tokens !== undefined ? ` · ${s.tokens} tok` : ''}${s.seconds !== undefined ? ` · ${s.seconds}s` : ''}`
          + `${s.detail ? ` · ${s.detail}` : ''}`);
      }
      return ok(lines.join('\n'), { workflowId: wf.id, status: wf.status });
    },
  }));

  ctx.logger.info('workflow tools registered (start/add_nodes/status)');
}
