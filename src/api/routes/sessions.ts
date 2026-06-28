import { streamSSE } from 'hono/streaming';
import { classifySession } from '../../overseer/sessionInfo.js';
import { parseBody } from '../validation.js';
import { launchSessionSchema, sessionKeysSchema, sessionInputSchema, sessionResizeSchema } from '../schemas/sessions.js';
import type { OrcaApp, RouteContext } from '../context.js';

/** Live tmux session surface: list, manual launch, kill, keystrokes/raw input, resize, pane capture,
 *  the live ANSI stream and a single-use ticket for the terminal WebSocket. Every control route is
 *  ownership-gated by sessionAccessible; a manual launch claims the shared checkout atomically. */
export function registerSessionRoutes(app: OrcaApp, ctx: RouteContext): void {
  const { d, sessionAccessible, canAccessProject, execAllowedForUser, sessionService, tickets } = ctx;
  app.get('/sessions', async c => c.json((await d.tmux.list())
    .filter((s) => s.startsWith('orca-'))
    // Visibility mirrors operability: a caller only sees sessions it may control (its projects' agents,
    // its own advisor; admin sees all). Without this the list leaked every running session cross-tenant.
    .filter((s) => sessionAccessible(c, s))
    .map((s) => {
      const info = classifySession(s);
      // Tag each session with its project from the agent store (every role upserts there at spawn), so
      // clients can show the repo for workers, pilots and overseers alike — the name alone can't.
      return { ...info, projectId: d.agents?.projectFor(s.slice('orca-'.length)) ?? undefined };
    })));
  app.post('/sessions', async (c) => {
    const { taskId, exec } = await parseBody(c, launchSessionSchema);
    if (exec && !d.config.get().allowedExecs.includes(exec)) return c.json({ error: 'exec not allowed' }, 400);
    if (exec && !execAllowedForUser(c, exec)) return c.json({ error: 'exec not allowed for user' }, 403);
    const task = d.tasks.get(taskId);
    if (!task) return c.json({ error: 'task not found' }, 404); // don't spawn a phantom agent for a missing task
    // Launch in the task's own project (multi-project), gated to the caller's access.
    if (!canAccessProject(c, task.project_id)) return c.json({ error: 'forbidden' }, 403);
    const result = await sessionService.launchManual(task, exec);
    if (!result.ok) {
      if (result.reason === 'busy') return c.json({ error: 'checkout busy' }, 409);
      return c.json({ error: `spawn failed: ${result.message}` }, 500);
    }
    return c.json({ session: result.session }, 201);
  });
  app.delete('/sessions/:name', async c => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    // Killing a user's advisor from the sessions list is an explicit "turn it off" — route it through
    // advisor.stop so it also persists advisor_autostart=false. A bare tmux.kill would leave the flag
    // on, and ensureOnLogin would resurrect the advisor on the next login (the "it comes back after I
    // killed it" bug). Plain agent/overseer sessions just get killed.
    const info = classifySession(name);
    if (info.role === 'advisor' && info.userId !== undefined && d.advisor) {
      await d.advisor.stop(info.userId);
      return c.json({ ok: true });
    }
    await d.tmux.kill(name); return c.json({ ok: true });
  });
  app.post('/sessions/:name/keys', async c => {
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    // The schema validates a non-empty list of plain key tokens and rejects any leading-'-' entry, so a
    // crafted token can't smuggle a tmux flag (e.g. `-t <other-session>`) into `tmux send-keys`.
    const { keys } = await parseBody(c, sessionKeysSchema);
    await d.tmux.sendKeys(c.req.param('name'), keys);
    return c.json({ ok: true });
  });
  app.post('/sessions/:name/input', async c => {
    // Raw interactive input: the xterm `onData` bytes (printable chars, control codes, ESC sequences)
    // are forwarded verbatim to the pane via `send-keys -l`, so the advisor terminal behaves like a
    // real one. `-l` + `--` (in the driver) make a leading '-' safe, so no flag-token validation here.
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    const { data } = await parseBody(c, sessionInputSchema);
    await d.tmux.sendRaw(c.req.param('name'), data);
    return c.json({ ok: true });
  });
  app.post('/sessions/:name/resize', async c => {
    if (!sessionAccessible(c, c.req.param('name'))) return c.json({ error: 'forbidden' }, 403);
    const { cols, rows } = await parseBody(c, sessionResizeSchema);
    await d.tmux.resize(c.req.param('name'), cols, rows);
    return c.json({ ok: true });
  });
  app.get('/sessions/:name/pane', async c => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    const pane = c.req.query('ansi') ? await d.tmux.capturePaneAnsi(name, 60) : await d.tmux.capturePane(name, 60);
    return c.json({ pane });
  });

  app.get('/sessions/:name/stream', (c) => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    return streamSSE(c, async (stream) => {
      let done = false;          // flips once: on abort, on too many errors, or on normal exit
      const frame = async () => {
        const pane = await d.tmux.capturePaneAnsi(name, 200);
        await stream.writeSSE({ data: JSON.stringify({ pane }), event: 'pane' });
      };
      await frame(); // first frame synchronously so clients render immediately
      let errs = 0;
      // capturePaneAnsi returns '' for a vanished session, so a throw here means the write failed
      // (closed client). After a short run of consecutive failures, stop pushing empty frames forever.
      const clear = d.clock.setInterval(() => {
        frame().then(() => { errs = 0; }).catch(() => { if (++errs >= 5) done = true; });
      }, 1000);
      // Single teardown: the abort listener flips `done`; the loop exits and `clear()` runs exactly
      // once (the previous code called stop() on both abort and loop-exit — a redundant double-clear).
      c.req.raw.signal.addEventListener('abort', () => { done = true; });
      while (!done && !c.req.raw.signal.aborted) await stream.sleep(1000);
      clear();
    });
  });

  // Mint a single-use ticket to open the terminal WebSocket stream for this session. Authenticated
  // here (via the BFF cookie) and ownership-gated by the same access check as every session route; the
  // unauthenticated `/ws/terminal` upgrade then redeems the ticket. The attach is interactive.
  app.post('/sessions/:name/ws-ticket', async (c) => {
    const name = c.req.param('name');
    if (!sessionAccessible(c, name)) return c.json({ error: 'forbidden' }, 403);
    const ticket = tickets.issue({ session: name, userId: c.get('user')?.id ?? null });
    return c.json({ ticket });
  });
}
