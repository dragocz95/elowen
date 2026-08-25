/** Transport-agnostic core for the chat adapters' control commands — new / fast / stop / status /
 *  compact / restart. These are pure gate → mutate/call → reply flows that were copy-pasted, byte for
 *  byte, across the Discord, Telegram and WhatsApp adapters. The stateful pickers (model, context,
 *  reasoning, voice, display) and /help stay per-surface: their rendering is transport-specific.
 *
 *  WHICH names reach this core is deliberately NOT stated in this file. The daemon's slash-command
 *  catalog is the only place a command is declared, and every adapter already receives that catalog for
 *  its own surface (`ctx.chatCommands(surface)`) — {@link controlCommandsFrom} derives the routing set
 *  from it.
 *
 *  The caller supplies a small binding object:
 *   - msg           the resolved per-language service messages
 *   - reply(text)   send one message on this surface. Every command below replies exactly once, so a
 *                   surface that must ACK first (Discord defers /compact within its 3s window and passes
 *                   its editOriginal as `reply`) can set that up per command.
 *   - isAdmin()     operator/admin gate for the invoking sender
 *   - state,stateId the shared per-conversation StateStore and this conversation's key
 *   - ctl,ref       the host control surface and this conversation's ref (ctl may be absent)
 *   - activeModel() resolve the model selected for this conversation (async; null when none) — used by
 *                   /fast to read the catalog capability before touching a possibly stale live session
 *   - arg           the command argument for text surfaces ('on'/'off' for /fast); Discord passes its
 *                   slash-option value */

/** The names an adapter routes to {@link runControlCommand}, derived from the catalog projection the
 *  daemon published for THIS surface. `execution: 'session-control'` means the daemon owns the effect;
 *  the pickers are excluded because a chooser is drawn per surface (`/context` is `session-control` too,
 *  but it lists and binds through dedicated PlatformControlApi methods and its own UI, not through here).
 *
 *  Membership is a NECESSARY condition, not a sufficient one. What actually runs is the INTERSECTION of
 *  this set with what `runControlCommand` implements: a published name this core does not own returns
 *  false and the caller falls through to its unknown-command path. That intersection is what keeps the
 *  two sides harmless when they ship at different times — a newer daemon may publish a control command an
 *  older adapter cannot run, and an adapter can never offer one the daemon did not publish. */
export function controlCommandsFrom(commands) {
  return new Set((Array.isArray(commands) ? commands : [])
    .filter((c) => c?.execution === 'session-control' && c?.kind !== 'picker')
    .map((c) => String(c.name)));
}

/** The complement of {@link controlCommandsFrom}: the names an adapter dispatches ITSELF. Everything the
 *  surface executes (`execution: 'surface-local'` — `/help`, `/model`, `/reasoning`) plus the pickers the
 *  daemon owns but cannot draw (`session-control` + `kind: 'picker'` — `/context`, whose listing and
 *  binding are PlatformControlApi calls behind a per-surface chooser). Together the two sets partition
 *  exactly what the daemon published for this surface, so no name is claimed twice and none is dropped.
 *
 *  FAIL CLOSED, and that is the whole point of the function. An empty projection means the adapter never
 *  received a catalog — a core too old to publish one, a failed fetch, a surface the daemon does not know
 *  — and an adapter that answered its hardcoded pickers anyway would be running commands the daemon never
 *  published. Then "the catalog decides which commands exist" would hold for the daemon-run half and
 *  quietly not for the local half. With nothing published, nothing is accepted: every `/word` falls
 *  through to the adapter's unknown-command path and reaches the brain as ordinary text.
 *
 *  `adapterOwned` carries the `adapter-state` names the CALLER implements (`voice`, `display`). Those are
 *  declared in the catalog but deliberately never published — each adapter registers its own, and the same
 *  name twice in one Discord bulk registration is a 400 that drops every slash command for the guild — so
 *  the catalog cannot answer for them and the adapter states them. They are gated on the projection being
 *  non-empty all the same: a live catalog is the adapter's evidence that it is talking to a daemon at all,
 *  and a channel whose commands have gone silent must not keep flipping local state as if nothing were
 *  wrong. */
export function localCommandsFrom(commands, adapterOwned = []) {
  const published = Array.isArray(commands) ? commands : [];
  if (published.length === 0) return new Set();
  const names = new Set(published
    .filter((c) => c?.execution === 'surface-local' || (c?.execution === 'session-control' && c?.kind === 'picker'))
    .map((c) => String(c.name)));
  for (const n of Array.isArray(adapterOwned) ? adapterOwned : []) names.add(String(n));
  return names;
}

/** The names that address the BOT rather than the conversation, which is the union of the two sets above
 *  and is derived as exactly that — a third filter over `execution` would be a third place the same
 *  classification is written down, and the one that goes stale. A surface that records a transcript keeps
 *  these OUT of it: they are said to the plugin, not to the room, and recording them teaches the model to
 *  answer `/model` as if it were a question. A plugin prompt macro (`execution: 'plugin-prompt'`) is
 *  deliberately absent — that one IS a turn the conversation had. */
export function botControlCommandsFrom(commands, adapterOwned = []) {
  return new Set([...controlCommandsFrom(commands), ...localCommandsFrom(commands, adapterOwned)]);
}

/** Run one control command. Returns true when handled (a reply was sent), false when `cmd` is not one
 *  this core implements — the caller then treats it as an unknown command. */
export async function runControlCommand(cmd, b) {
  const { msg, reply, isAdmin, state, stateId, ctl, ref } = b;
  switch (cmd) {
    case 'new': {
      state.patch(stateId, { gen: (state.get(stateId).gen ?? 0) + 1 });
      await reply(msg.newConversation);
      return true;
    }
    case 'fast': {
      if (!isAdmin()) { await reply(msg.controlForbidden); return true; }
      const a = String(b.arg ?? '').toLowerCase();
      if (a && a !== 'on' && a !== 'off') { if (msg.fastUsage) await reply(msg.fastUsage); return true; }
      const saved = state.get(stateId).fast === true;
      const wanted = a === 'on' ? true : a === 'off' ? false : !saved;
      const active = await b.activeModel();
      // Validate the selected catalog model before touching a possibly stale live session, which may
      // still be running the previous model until the next message rebuilds it.
      if (!active?.fastAvailable) {
        if (wanted) { await reply(msg.fastUnavailable); return true; }
        // A stale persisted `fast:true` must remain switchable off after moving to a non-OAuth model.
        state.patch(stateId, { fast: false });
        await reply(msg.fastSet(false));
        return true;
      }
      const live = ctl?.status?.(ref) ?? null;
      const liveMatchesSelection = live?.provider === active.provider && live.model === active.model;
      const result = liveMatchesSelection ? (ctl?.setFast(ref, wanted) ?? null) : null;
      if (result && !result.fastAvailable) { await reply(msg.fastUnavailable); return true; }
      state.patch(stateId, { fast: wanted });
      await reply(msg.fastSet(wanted));
      return true;
    }
    case 'stop': case 'status': case 'compact': {
      if (!isAdmin()) { await reply(msg.controlForbidden); return true; }
      if (!ctl) { await reply(msg.noSession); return true; }
      if (cmd === 'stop') {
        const st = ctl.status(ref);
        if (!st?.streaming) { await reply(msg.nothingRunning); return true; }
        await ctl.abort(ref);
        await reply(msg.stopped);
        return true;
      }
      if (cmd === 'status') {
        const st = ctl.status(ref);
        await reply(st ? msg.status(st.model, st.usage.percent ?? 0, st.usage.tokens ?? 0) : msg.noSession);
        return true;
      }
      // /compact runs an LLM summary. Three outcomes: no session (null), a benign no-op
      // (compacted:false → nothing to compact yet), or a real failure (throw).
      try {
        const res = await ctl.compact(ref);
        await reply(!res ? msg.noSession : (res.compacted ? msg.compacted(res.usage.percent ?? 0) : msg.nothingToCompact));
      } catch { await reply(msg.compactFailed); }
      return true;
    }
    case 'restart': {
      if (!isAdmin()) { await reply(msg.restartForbidden); return true; }
      if (!ctl) { await reply(msg.restartUnavailable); return true; }
      try { await ctl.restart(); await reply(msg.restarting); }
      catch { await reply(msg.restartUnavailable); }
      return true;
    }
    default:
      return false;
  }
}
