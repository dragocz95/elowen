import { parseBody } from '../validation.js';
import { brainStopSchema, brainVisibilitySchema, brainSendSchema, brainModelSchema, brainToggleSchema, brainThinkSchema, brainCwdSchema, brainCompactSchema, brainContextSchema, brainTerminalSchema, brainGoalSchema, brainAnswerSchema, subagentSendSchema } from '../schemas/brain.js';
import { commandsWithPlugins, findCommand, type SlashSurface } from '../../brain/slashCommands.js';
import { logger } from '../../shared/logger.js';
import type { ElowenApp } from '../context.js';
import { clientOrigin } from '../clientIp.js';
import { PLATFORM_SURFACES } from '../../shared/platformIdentity.js';
import type { BrainRouteContext } from './brainRouteContext.js';

/** Normalize a client-supplied `/compact <text>` instruction: require a string, trim, drop empty, and cap
 *  the length so a stray large payload can't bloat the summary prompt. Undefined means "default compaction". */
function compactInstruction(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, 2000) : undefined;
}

export function registerBrainChatRoutes(app: ElowenApp, route: BrainRouteContext): void {
  const { d, forbidden, pinOrigin, withBrain } = route;
  // Stop the streaming turn (the Esc key in chat clients). `session` scopes it to the caller's own
  // bound conversation (the CLI); absent → the active one.
  app.post('/brain/abort', withBrain(async (c, brain) => {
    const { session } = await parseBody(c, brainStopSchema);
    try { await brain.abort(c.get('user').id, session); return c.json({ ok: true }); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Esc with a queued owner message: atomically interrupt the active PI run and promote the oldest queue
  // entry into a fresh user turn. Client generation fencing prevents a delayed request from reviving a
  // conversation after that CLI switched/stopped.
  app.post('/brain/interrupt-queued', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.interruptQueued(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Ctrl+B: release foreground delegate tool waits without cancelling their child channels. The plugin
  // keeps the jobs alive; BrainService routes their eventual results back into this exact conversation.
  app.post('/brain/subagents/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundSubagents(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // A tab reporting that it went to the background, or came back. Presence only: the stream stays
  // attached either way, so nothing about the session's lifecycle changes — it only decides whether a
  // finished turn reaches for the user's phone instead of assuming somebody is reading the answer. A
  // browser keeps its SSE stream open behind a locked screen, so attachment alone cannot tell these apart.
  app.post('/brain/visibility', withBrain(async (c, brain) => {
    const { client, hidden } = await parseBody(c, brainVisibilitySchema);
    return c.json(brain.setClientVisibility(c.get('user').id, client, hidden));
  }));

  // Ctrl+B: move a running foreground Bash command to the background without killing it. The plugin keeps
  // it running; its exit later nudges this same conversation, exactly like Bash(background=true).
  app.post('/brain/commands/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundCommands(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Stop escalation (a further Esc / repeat Ctrl+C after the graceful interrupt): hard-kill the running
  // foreground Bash command(s) of this conversation. The turn's abort has already been requested by the
  // client; killing settles the Bash tool as [killed], which lets the parked agent loop unwind instead of
  // waiting the command out. Same body shape as the background routes above.
  app.post('/brain/commands/kill', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.killForegroundCommands(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Ctrl+B: detach a foreground WorkflowStart so its DAG keeps running and delivers its summary back
  // into this conversation, exactly like a background workflow. Same shape as the two routes above.
  app.post('/brain/workflows/background', withBrain(async (c, brain) => {
    const { session, client, generation } = await parseBody(c, brainStopSchema);
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    try { return c.json(await brain.detachForegroundWorkflows(c.get('user').id, session, boundClient)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Closing a session-bound client: abort its active run and dispose the live PI session only when no
  // other client is attached. Persisted history remains resumable. `detachOnly` (the web beacon) keeps the
  // binding release but refuses the teardown while work is in flight — a closing tab must not kill an
  // agent. Logged on both outcomes: this route used to be silent, which made a phone-lock teardown
  // impossible to confirm from the daemon log.
  app.post('/brain/session/stop', withBrain(async (c, brain) => {
    const { session, client, generation, detachOnly } = await parseBody(c, brainStopSchema);
    try {
      const result = await brain.stopSession(c.get('user').id, session, client, generation, { detachOnly: detachOnly === true });
      logger('brain').info(`session stop: session=${session ?? '-'} client=${client ?? '-'} generation=${generation ?? '-'} detachOnly=${detachOnly === true} → stopped=${result.stopped} disposed=${result.disposed}`);
      return c.json(result);
    } catch (e) {
      logger('brain').warn(`session stop failed: session=${session ?? '-'} client=${client ?? '-'} — ${(e as Error).message}`);
      return c.json({ error: (e as Error).message }, 404);
    }
  }));

  // Switch the active conversation (or the caller's explicit `session`) to another configured model (the
  // /model picker). The session respawns in place under the same id — open SSE taps survive the respawn
  // and every attached client reconciles via the pushed `session-event`, so no client reopens its stream.
  app.post('/brain/model', withBrain(async (c, brain) => {
    const { session, ...sel } = await parseBody(c, brainModelSchema);
    try { return c.json(await brain.switchModel(c.get('user').id, sel, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Bind (MOVE, not fork) one of the caller's OWN conversations into a platform channel/thread (the
  // /context picker): the chosen session is re-keyed onto `brain-ch-<channel>` so the channel's next turn
  // continues in it, and whatever occupied the slot is archived. A `picker`, so it can NOT go through
  // POST /brain/command (that handler rejects kind!=='action') — hence this dedicated endpoint. Unlike
  // POST /brain/model (which only mutates the caller's OWN session), binding mutates SHARED channel state
  // on a caller-supplied `channel` target, so it is ADMIN-gated here too — matching the operator gate the
  // platform adapters already apply — on top of the ownership guard inside bindChannelContext (caller-owned
  // sessions only). `channel` is the keyOf key (e.g. 'discord-123'); a guard rejection surfaces as 409.
  app.post('/brain/context', withBrain(async (c, brain) => {
    const { channel, session } = await parseBody(c, brainContextSchema);
    try { return c.json(await brain.bindChannelContext(c.get('user').id, channel, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }, { admin: true }));

  // Open (or re-attach to) an admin's interactive `elowen chat` terminal bound to one of THEIR OWN
  // conversations. ADMIN-only (invariant 4): agent tokens AND ordinary full-scope non-admins are rejected
  // 403 — the same is_admin gate /brain/context uses. Ownership is enforced inside open() (a foreign
  // admin's session throws `unknown session`), so the generic admin bypass never widens this. The response
  // carries only { terminal, created } — the per-terminal token (invariant 5) never leaves the daemon.
  // The running state is DERIVED from the owner-filtered GET /sessions (no separate polling endpoint).
  app.post('/brain/terminal', withBrain(async (c) => {
    if (!d.brainTerminal) return c.json({ error: 'brain unavailable' }, 503);
    const { session } = await parseBody(c, brainTerminalSchema);
    try { return c.json(await d.brainTerminal.open(c.get('user').id, session), 201); }
    catch (e) {
      // Never echo raw error text here: open()'s launch-failure path would otherwise carry the tmux argv
      // (and thus the per-terminal token) into the response body. Only the known ownership rejection is
      // surfaced verbatim; open() already sanitizes launch failures to a constant, and any other throw
      // collapses to that same constant so nothing sensitive leaks (invariant 5).
      const msg = (e as Error).message;
      if (msg === 'unknown session') return c.json({ error: msg }, 404);
      return c.json({ error: 'terminal launch failed' }, 409);
    }
  }, { admin: true }));

  // Set the active conversation's reasoning effort live (the /think command) — no session rebuild.
  //
  // The level is ALSO written to the caller's account default, and that is the whole point. A reload
  // builds a fresh session from that default, so while the picker only touched the live conversation
  // the effect was: change the level, press F5, and the old one is back. Two places claimed to hold
  // the reasoning effort and neither was the answer. Now the picker and Account → Elowen AI are one
  // value, whichever surface moved it — the web dock, the CLI's /reasoning, or a slash command.
  //
  // Only a person's own token gets this far: withBrain already refuses an agent-scoped one, so nothing
  // a spawned agent does can rewrite the default that outlives its conversation.
  //
  // The EFFECTIVE level is persisted, not the requested one — the model may clamp it, and storing the
  // asked-for value would put back exactly the disagreement this removes.
  app.post('/brain/think', withBrain(async (c, brain) => {
    const { level, session } = await parseBody(c, brainThinkSchema);
    try {
      const applied = await brain.setThinkingLevel(c.get('user').id, level, session);
      d.userSettings?.setCliSettings(c.get('user').id, { thinkingLevel: applied.thinkingLevel });
      return c.json(applied);
    }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Record that the client moved its working directory (the CLI's /cd). The cwd itself already rides
  // every turn; this only annotates the conversation so the agent is told, and rejects a directory the
  // caller's policy would refuse rather than announcing a move that cannot happen.
  app.post('/brain/cwd', withBrain(async (c, brain) => {
    const { dir, session } = await parseBody(c, brainCwdSchema);
    try { return c.json(brain.noteWorkDir(c.get('user').id, dir, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // OpenAI OAuth priority service tier (`service_tier: priority`). Session-scoped and live, like YOLO;
  // unsupported providers are rejected instead of silently pretending Fast is active.
  app.post('/brain/fast', withBrain(async (c, brain) => {
    const { on, session } = await parseBody(c, brainToggleSchema);
    try { return c.json(brain.setFast(c.get('user').id, on, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // SESSION-scoped YOLO override (the CLI /yolo command): flips "ask" permission rules to auto-approve
  // for the caller's ACTIVE live conversation only (deny rules still deny). `on` absent → toggle the
  // current effective state. The persisted per-user default lives at /auth/me/permissions.
  app.post('/brain/yolo', withBrain(async (c, brain) => {
    const { on, session } = await parseBody(c, brainToggleSchema);
    try { return c.json(brain.setYolo(c.get('user').id, on, session)); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // Manual context compaction (the /compact command in chat clients). Returns the fresh usage numbers
  // plus whether anything was compacted — a too-small/already-compacted session is a benign no-op
  // (200 with compacted:false), NOT an opaque 409, so clients show a friendly notice instead of a failure.
  app.post('/brain/compact', withBrain(async (c, brain) => {
    const { session, instruction } = await parseBody(c, brainCompactSchema);
    try { return c.json(await brain.compact(c.get('user').id, session, compactInstruction(instruction))); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // The published slash-command catalog for one surface + user — the SINGLE source of truth
  // (src/brain/slashCommands.ts). Every chat client renders its menu / registers its commands from this,
  // so a new command is added in one place and appears in CLI, Discord and the web dock at once.
  app.get('/brain/commands', async c => {
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    const q = c.req.query('surface');
    const surface: SlashSurface = q === 'cli' || (!!q && (PLATFORM_SURFACES as readonly string[]).includes(q)) ? (q as SlashSurface) : 'web';
    // Built-ins + any plugin-contributed prompt commands from the live registry (surface-scoped; a plugin
    // can never shadow a built-in — enforced both at registration and in commandsWithPlugins).
    const registry = await d.plugins?.get().catch(() => null);
    const pluginCommands = registry
      ? [...registry.commands.values()].map((cmd) => ({ ...cmd, plugin: registry.commandOwner.get(cmd.name) }))
      : [];
    // No registry (still loading, or it failed) means nothing is running, so every plugin-gated built-in
    // is withheld rather than advertised on a hunch.
    return c.json({ commands: commandsWithPlugins(surface, !!c.get('user').is_admin, pluginCommands, registry?.loadedNames ?? new Set()) });
  });

  // Execute a server-side (`action`) slash command through ONE dispatch path for every surface. Pickers
  // (`model`/`think`) and info (`stats`/`help`) stay client-side (their own endpoints / rendering).
  app.post('/brain/command', withBrain(async (c, brain) => {
    const user = c.get('user');
    // Polymorphic dispatch body: `name` selects the command and the remaining fields are per-command, so
    // this one stays a permissive hand-rolled read rather than a single zod schema (mirrors the streaming
    // handler). A bad `name` is a 400 below either way.
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; session?: unknown; on?: unknown; instruction?: unknown };
    const cmd = typeof body.name === 'string' ? findCommand(body.name) : undefined;
    if (!cmd || cmd.kind !== 'action') return c.json({ error: 'unknown command' }, 400);
    if (cmd.adminOnly && !user.is_admin) return c.json({ error: 'forbidden' }, 403);
    try {
      switch (cmd.name) {
        case 'stop': await brain.abort(user.id, typeof body.session === 'string' ? body.session : undefined); return c.json({ ok: true, message: 'Agent stopped.' });
        case 'new': return c.json({ ok: true, message: 'Started a fresh conversation.', data: await brain.start(user.id, { fresh: true }) });
        // Destructive and deliberate: it empties the caller's own conversation in place. A conversation
        // with work in flight throws, which the catch below turns into a 409 carrying the reason.
        case 'clear': {
          const data = await brain.clearSession(user.id, typeof body.session === 'string' ? body.session : undefined);
          return c.json({ ok: true, message: 'Conversation cleared.', data });
        }
        case 'compact': {
          const target = typeof body.session === 'string' ? body.session : undefined;
          // A compaction runs a summarizing model turn, so its tokens are spend like any other and are
          // attributed to whoever asked for it. preflightSend is used purely as the ownership-checked
          // resolver of "which conversation is this about"; a failure here is not this route's error.
          try { pinOrigin(c, brain.preflightSend(user.id, target)); } catch { /* no conversation to attribute */ }
          const r = await brain.compact(user.id, target, compactInstruction(body.instruction));
          return c.json({ ok: true, message: r.compacted ? 'Conversation compacted.' : (r.message ?? 'Nothing to compact yet.'), data: { usage: r.usage } });
        }
        case 'fast': {
          const r = brain.setFast(user.id, typeof body.on === 'boolean' ? body.on : undefined, typeof body.session === 'string' ? body.session : undefined);
          return c.json({ ok: true, message: `Fast mode ${r.fast ? 'enabled' : 'disabled'}.`, data: r });
        }
        case 'restart':
          if (!d.restartDaemon) return c.json({ error: 'restart is not available on this deployment' }, 501);
          await d.restartDaemon(user.id);
          return c.json({ ok: true, message: 'Restarting the Elowen daemon…' });
        default: return c.json({ error: 'command is not server-dispatchable' }, 400);
      }
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  app.post('/brain/send', withBrain(async (c, brain) => {
    const { text, images, mode, cwd, session, display, client, generation, surface } = await parseBody(c, brainSendSchema);
    // `session` binds the turn to the caller's own explicit conversation (ownership-checked in send();
    // channel/task sessions rejected). Absent → the active conversation, exactly as before. `display` is
    // the clean text the daemon echoes back as the authoritative `user` turn (the client no longer echoes
    // optimistically); absent → the model-facing text is shown.
    const boundClient = session && client && generation ? { id: client, generation } : undefined;
    // preflightSend resolves the conversation this turn will land in (the bound session, else the active
    // one) and throws when there is none — so it is both the guard and the only place the target id is
    // known BEFORE the turn starts, which is exactly when the origin has to be captured.
    try { brain.preflightSend(c.get('user').id, session, boundClient); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); } // not started yet / unknown session
    // The origin pin and the team-feed row are the brain's to record, not this route's — see openTurn.
    // This layer contributes only what it alone can see: WHERE the request came from, and which of the
    // two owner surfaces claims to have sent it (web and CLI post an identical body, so that one stays
    // the client's own statement and the daemon validates it against the known surfaces).
    // A model/tool turn can outlive nginx/SSH proxy request timeouts while its authoritative output is
    // already flowing over SSE. Wait only until the user row + stream echo are durable, then return 202.
    // A failure before that boundary is an HTTP error; a later failure is an ordered SSE error so an
    // attached TUI/headless client cannot silently lose an accepted prompt.
    const operation = brain.startSend({
      userId: c.get('user').id,
      text,
      images,
      mode,
      clientCwd: cwd,
      session,
      display,
      client: boundClient,
      origin: clientOrigin(c, d.config.get().security.trustProxy),
      ...(surface ? { surface } : {}),
    });
    void operation.completed.catch(async (error) => {
      try {
        const admittedSession = await operation.admitted;
        logger('brain-send').error(`accepted turn failed for ${admittedSession}`, error);
        brain.publishAcceptedSendFailure(admittedSession, error);
      } catch { /* pre-admission failure is returned by this request below */ }
    });
    try { await operation.admitted; }
    catch (error) {
      logger('brain-send').error('turn admission failed', error);
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    return c.json({ ok: true, accepted: true }, 202);
  }));

  // The caller's pending mid-turn backlog (messages sent while a turn streams are STEERED into it and
  // reported by PI until delivered). `session` scopes it to a bound CLI's conversation; absent → the
  // active one. Full snapshot (id + text) — the same shape the `queue` stream event carries, so clients
  // seed and reconcile alike.
  app.get('/brain/queue', c => {
    if (!d.brain) return c.json([]);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain.queueList(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  // Drop the pending mid-turn backlog (the CLI's queue-remove keybind / the web × button). PI steers a
  // mid-turn message into the running turn within a step or two, so there is no per-id removal to target —
  // the `:id` is accepted for wire compatibility and ignored; this clears whatever is still pending.
  // Always 200 with { removed } (false when nothing was pending). The cleared snapshot fans out via the
  // `queue` stream event.
  app.delete('/brain/queue/:id', withBrain((c, brain) => {
    try { return c.json({ removed: brain.queueRemove(c.get('user').id, c.req.param('id')!, c.req.query('session')) }); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Pop the LAST pending mid-turn message and return its text — the CLI ↑-recall (restores it to the
  // composer) and ctrl+x remove-last. Pops by value from the authoritative queue, not the fragile
  // positional id, so it can never leave a message both queued and re-sendable. { text: null } when the
  // queue is already empty. The reduced snapshot fans out via the `queue` stream event.
  app.post('/brain/queue/recall', withBrain((c, brain) => {
    try { return c.json(brain.queueRecall(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  // Answer a parked AskUserQuestion. Deliberately bypasses the per-turn send() lock (the parked turn
  // holds it) — it just resolves the registry Promise, so it never deadlocks. An unknown/expired id is a
  // tolerated no-op (matched:false) rather than an error, so a late double-click is harmless.
  app.post('/brain/answer', withBrain(async (c, brain) => {
    const { id, answers } = await parseBody(c, brainAnswerSchema);
    const matched = brain.answerQuestion(id, answers, c.get('user').id); // owner route: only the caller's own question
    return c.json({ ok: true, matched });
  }));

  // Goal routes: `session` (query on GET/action, body on POST) scopes the goal to the caller's own
  // bound conversation (the CLI); absent → the active one.
  app.get('/brain/goal', c => {
    if (!d.brain) return c.json(null);
    if (forbidden(c)) return c.json({ error: 'forbidden' }, 403);
    try { return c.json(d.brain.goalStatus(c.get('user').id, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  });

  app.post('/brain/goal', withBrain(async (c, brain) => {
    const { text, draft, turnBudget: rawBudget, session } = await parseBody(c, brainGoalSchema);
    const turnBudget = rawBudget !== undefined && Number.isFinite(rawBudget) ? Math.max(1, Math.min(50, Math.floor(rawBudget))) : undefined;
    try { return c.json(await brain.setGoal(c.get('user').id, text, { draft: draft === true, turnBudget }, session), 201); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  app.post('/brain/goal/action', withBrain((c, brain) => {
    const action = c.req.query('action');
    if (action !== 'pause' && action !== 'resume' && action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try { return c.json(brain.goalAction(c.get('user').id, action, c.req.query('session'))); }
    catch { return c.json({ error: 'unknown session' }, 404); }
  }));

  app.post('/brain/subgoal', withBrain(async (c, brain) => {
    // Polymorphic on `action` (add carries `text`, remove carries `index`), so a hand-rolled read rather
    // than a single schema — like /brain/command. An unknown action is a 400 below.
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown; text?: unknown; index?: unknown; session?: unknown };
    if (body.action !== 'add' && body.action !== 'remove' && body.action !== 'clear') return c.json({ error: 'unknown action' }, 400);
    try {
      const value = body.action === 'add' ? body.text : body.action === 'remove' ? body.index : undefined;
      return c.json(brain.subgoal(c.get('user').id, body.action, value as string | number | undefined, typeof body.session === 'string' ? body.session : undefined));
    } catch (e) { return c.json({ error: (e as Error).message }, 409); }
  }));

  // The owner talking into a delegated sub-agent's session: steered into its running turn, or run as
  // a fresh turn when the child is idle. Fire-and-forget — the reply rides the tapped session stream
  // (an idle child's turn can take minutes; blocking the HTTP call on it would just time out).
  app.post('/brain/subagent/send', withBrain(async (c, brain) => {
    const body = await parseBody(c, subagentSendSchema);
    try { brain.messagesOf(c.get('user').id, body.session); } catch { return c.json({ error: 'unknown session' }, 404); }
    // Validate the durable child boundary before detaching the potentially minutes-long turn. Without this
    // preflight, a legacy child (no persisted scope) would reject inside the swallowed Promise and the
    // caller would receive a misleading `{ok:true}` with no continuation ever running.
    try { brain.preflightSubagentSend(c.get('user').id, body.session); }
    catch (e) { return c.json({ error: (e as Error).message }, 409); }
    // The child's own session, not the parent's: a sub-agent turn ordered by hand is attributed to the
    // human who typed into it. A sub-agent turn the PARENT spawns has no request of its own and settles
    // as `internal`, which is the honest answer — nobody typed it.
    pinOrigin(c, body.session);
    void brain.sendToSubagent(c.get('user').id, body.session, body.text).catch(() => { /* surfaced on the child's stream */ });
    return c.json({ ok: true });
  }));

}
