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

/** The names that address the BOT rather than the conversation: everything the daemon executes
 *  (`session-control`) or the surface itself executes (`surface-local`), plus the `adapter-state`
 *  commands the calling adapter implements. A surface that records a transcript keeps these OUT of it —
 *  they are said to the plugin, not to the room, and recording them teaches the model to answer `/model`
 *  as if it were a question. A plugin prompt macro (`execution: 'plugin-prompt'`) is deliberately absent:
 *  that one IS a turn the conversation had.
 *
 *  `adapter-state` entries are declared in the catalog but never published — each adapter registers its
 *  own, and the same name twice in one Discord bulk registration is a 400 that drops every slash command
 *  for the guild — so the adapter that implements one passes its names in `adapterOwned`. */
export function botControlCommandsFrom(commands, adapterOwned = []) {
  const names = new Set((Array.isArray(adapterOwned) ? adapterOwned : []).map((n) => String(n)));
  for (const c of Array.isArray(commands) ? commands : []) {
    if (c?.execution === 'session-control' || c?.execution === 'surface-local') names.add(String(c.name));
  }
  return names;
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
