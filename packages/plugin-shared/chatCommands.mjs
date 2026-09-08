/** Transport-agnostic core for the chat adapters' control commands — new / fast / stop / status /
 *  compact / restart, plus the published `session-control` pickers /context and /project. The actions
 *  are pure gate → mutate/call → reply flows that were copy-pasted, byte for byte, across the Discord,
 *  Telegram and WhatsApp adapters. The pickers joined them once /project arrived: a second per-surface
 *  copy of the context listing/binding flow (four adapters × renderers) was already the drift this file
 *  exists to prevent, so everything but the DRAWING moved in — the gate, the listing, the empty and
 *  unlinked states, the bind/switch call and the reply. A surface keeps exactly two seams: it renders
 *  the descriptor this core builds (`b.showPicker`) and hands a choice back to {@link applyPickerChoice}.
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
 *   - isAdmin()     operator/admin gate for the invoking sender (/context is the one picker behind it;
 *                   /project is deliberately not gated — see runPickerCommand)
 *   - state,stateId the shared per-conversation StateStore and this conversation's key
 *   - ctl,ref       the host control surface and this conversation's ref (ctl may be absent)
 *   - senderPlatformId the invoking sender's platform id, resolved to their linked Elowen account for
 *                   every identity-scoped host call (listContext/listProjects, bindContext/switchProject)
 *   - showPicker(d, page)
 *                   render one picker descriptor: page 0 opens the chooser, page > 0 redraws a paged
 *                   chooser in place. Only a surface that can redraw without re-listing (Discord) uses
 *                   page; the pending-descriptor surfaces page out of their own cache instead.
 *   - activeModel() resolve the model selected for this conversation (async; null when none) — used by
 *                   /fast to read the catalog capability before touching a possibly stale live session
 *   - arg           the command argument for text surfaces ('on'/'off' for /fast, '<slug|id>' for
 *                   /project); Discord passes its slash-option value */

/** The names an adapter routes to the control cores, derived from the catalog projection the daemon
 *  published for THIS surface. `execution: 'session-control'` means the daemon owns the effect, pickers
 *  included — the chooser of a `session-control` picker is per-surface, but the operation behind it is a
 *  PlatformControlApi call the daemon defines, and that is exactly the half the shared cores own. A
 *  `surface-local` picker (/model) never enters: the daemon runs nothing behind it.
 *
 *  Membership is a NECESSARY condition, not a sufficient one. What actually runs is the INTERSECTION of
 *  this set with what the two cores implement: a published name neither core owns returns false twice and
 *  the caller falls through to its unknown-command path. That intersection is what keeps the two sides
 *  harmless when they ship at different times — a newer daemon may publish a control command an older
 *  adapter cannot run, and an adapter can never offer one the daemon did not publish. */
export function controlCommandsFrom(commands) {
  return new Set((Array.isArray(commands) ? commands : [])
    .filter((c) => c?.execution === 'session-control')
    .map((c) => String(c.name)));
}

/** The complement of {@link controlCommandsFrom}: the names an adapter dispatches ITSELF. Everything the
 *  surface executes (`execution: 'surface-local'` — `/help`, `/model`, `/reasoning`). Together the two
 *  sets partition exactly what the daemon published for this surface, so no name is claimed twice and
 *  none is dropped: the session-control half (actions and pickers alike) runs through the shared cores,
 *  the surface-local half through the adapter's own switch and chooser.
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
    .filter((c) => c?.execution === 'surface-local')
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

/** Upper bound of items one picker lists — the ceiling the per-surface /context copies already used.
 *  Every surface pages its chooser (or the host caps the listing), so this bounds one listing fetch. */
const PICKER_LIST_LIMIT = 200;

/** Run one control command. Returns true when handled (a reply was sent), false when `cmd` is not one
 *  this core implements — the caller then treats it as an unknown command, or (a published picker) hands
 *  it to {@link runPickerCommand}. */
export async function runControlCommand(cmd, b) {
  const { msg, reply, isAdmin, state, stateId, ctl, ref } = b;
  switch (cmd) {
    case 'new': {
      state.patch(stateId, { gen: (state.get(stateId).gen ?? 0) + 1 });
      await reply(msg.newConversation);
      return true;
    }
    case 'fast': {
      const a = String(b.arg ?? '').toLowerCase();
      if (a && a !== 'on' && a !== 'off' && a !== 'status') { if (msg.fastUsage) await reply(msg.fastUsage); return true; }
      const active = await b.activeModel();
      const senderPlatformId = typeof b.senderPlatformId === 'string' ? b.senderPlatformId : '';
      if (a === 'status') {
        const result = senderPlatformId ? (ctl?.fastStatus?.(ref, senderPlatformId) ?? null) : null;
        if (!result) { await reply(msg.fastAccountRequired ?? msg.controlForbidden); return true; }
        await reply(msg.fastStatus ? msg.fastStatus(result.fast, active?.fastAvailable === true) : msg.fastSet(result.fast));
        return true;
      }
      const wanted = a === 'on' ? true : a === 'off' ? false : undefined;
      const result = senderPlatformId ? (ctl?.setAccountFast?.(ref, senderPlatformId, wanted) ?? null) : null;
      if (!result) { await reply(msg.fastAccountRequired ?? msg.controlForbidden); return true; }
      if (result.fast && active?.fastAvailable !== true && msg.fastSetUnsupported) {
        await reply(msg.fastSetUnsupported(true));
      } else {
        await reply(msg.fastSet(result.fast));
      }
      return true;
    }
    case 'stop': case 'stats': case 'compact': {
      if (!isAdmin()) { await reply(msg.controlForbidden); return true; }
      if (!ctl) { await reply(msg.noSession); return true; }
      if (cmd === 'stop') {
        const st = ctl.status(ref);
        if (!st?.streaming) { await reply(msg.nothingRunning); return true; }
        await ctl.abort(ref);
        await reply(msg.stopped);
        return true;
      }
      if (cmd === 'stats') {
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

/** Build the normalized descriptor for one published picker, or send its terminal reply (the operator
 *  gate, an empty or unresolvable listing) and return null. `undefined` means `cmd` is not a picker this
 *  core owns — the caller falls through, exactly like a control action an old core cannot run.
 *
 *  The descriptor is the whole contract between the shared core and the per-surface renderer: `items`
 *  carry a transport value, a label and an optional secondary hint, and nothing else. The host's project
 *  shape carries an absolute path; it is host-side data and deliberately never copied in, so no renderer
 *  can leak a path only the switching account may read into a shared room. */
async function pickerDescriptor(cmd, b) {
  const { msg, reply, isAdmin, ctl, ref, senderPlatformId } = b;
  if (cmd === 'context') {
    // Operator-gated like /model: binding exposes the chosen history to everyone in the room. Ownership
    // stays the real boundary — the listing offers only the invoking sender's OWN conversations (the
    // bare default excluded server-side) and bindContext re-checks. An unlinked sender has nothing to
    // bind, and that is exactly what the empty text says.
    if (isAdmin && !isAdmin()) { await reply(msg.controlForbidden); return null; }
    const listing = ctl?.listContext?.(ref, senderPlatformId, { offset: 0, limit: PICKER_LIST_LIMIT }) ?? null;
    if (!listing || !listing.items?.length) { await reply(msg.noContextSessions); return null; }
    return {
      picker: 'context',
      title: msg.pickContext,
      placeholder: msg.contextPlaceholder,
      items: listing.items.map((s) => ({
        value: String(s.id),
        label: String(s.title || 'Untitled'),
        ...(s.model ? { hint: String(s.model) } : {}),
      })),
    };
  }
  if (cmd === 'project') {
    // Deliberately NO operator gate: binding someone else's history into the room is an operator decision
    // (/context), while a project switch moves the conversation into a directory only the SWITCHING
    // account itself reaches — the host resolves that sender's own project policy and re-validates it on
    // the switch, so every linked writer may call it. Unlinked is its own state, because there is no
    // account to resolve a policy for.
    if (!ctl) { await reply(msg.noSession); return null; }
    if (typeof ctl.listProjects !== 'function') { await reply(msg.projectUnavailable); return null; }
    const projects = await ctl.listProjects(ref, senderPlatformId);
    if (projects === null) { await reply(msg.projectAccountRequired); return null; }
    if (projects.length === 0) { await reply(msg.noProjects); return null; }
    return {
      picker: 'project',
      title: msg.pickProject,
      placeholder: msg.projectPlaceholder,
      items: projects.map((p) => ({ value: String(p.id), label: String(p.slug) })),
    };
  }
  return undefined;
}

/** Run one published picker invocation (`/context`, `/project`). Returns true when handled — a terminal
 *  reply was sent (forbidden / nothing to offer), the chooser was rendered through
 *  `b.showPicker(descriptor, page)`, or for /project a typed `<slug|id>` argument resolved and switched in
 *  one step — and false when `cmd` is not a picker this core owns, so the caller falls through. `page`
 *  re-lists for a surface that redraws a paged chooser in place (Discord's nav buttons); surfaces that
 *  page out of their own pending cache never pass one.
 *
 *  The gates run again on every page redraw for the same reason the choice re-checks them: the chooser
 *  round-trips independently of the invocation that opened it. */
export async function runPickerCommand(cmd, b, page = 0) {
  // A typed `/project <slug|id>` argument skips the chooser entirely: it resolves and switches in one
  // step. Bare `/project` falls through to the descriptor and opens the same chooser as /context.
  if (cmd === 'project' && String(b.arg ?? '').trim()) return applyProjectChoice(b.arg, b);
  const d = await pickerDescriptor(cmd, b);
  if (d === undefined) return false;
  if (d) await b.showPicker(d, page);
  return true;
}

/** Resolve one picker choice through the host, as the CURRENT person choosing — the identity at click
 *  time, never whoever opened the chooser (a card round-trips and can be picked up by someone else).
 *  Returns true when `picker` is one this core owns; the reply (bound/switched/error) went through
 *  `b.reply`. Returns false for anything else, so a stale component from a retired picker falls through
 *  to the adapter's unknown-interaction path.
 *
 *  /context re-checks the operator gate on submit — the chooser round-trips independently of the gate
 *  that opened it. /project has none at either end. */
export async function applyPickerChoice(picker, value, b) {
  const { msg, reply, isAdmin, ctl, ref, senderPlatformId } = b;
  if (picker === 'context') {
    if (isAdmin && !isAdmin()) { await reply(msg.controlForbidden); return true; }
    if (!ctl?.bindContext) { await reply(msg.noSession); return true; }
    const sessionId = String(value ?? '').trim();
    if (!sessionId) { await reply(msg.contextError('no conversation selected')); return true; }
    try {
      const { title } = await ctl.bindContext(ref, senderPlatformId, sessionId);
      await reply(msg.contextBound(title));
    } catch (e) {
      await reply(msg.contextError(e?.message ?? e));
    }
    return true;
  }
  if (picker === 'project') return applyProjectChoice(value, b);
  return false;
}

/** One /project resolution and switch — shared by a chooser pick (the value is always the decimal id)
 *  and a typed `/project <slug|id>` argument. Resolution is an EXACT project slug first, then the
 *  decimal id, so a hand-typed name and a chooser value meet one code path; the switch itself re-validates
 *  the invoking sender's policy server-side. */
async function applyProjectChoice(raw, b) {
  const { msg, reply, ctl, ref, senderPlatformId } = b;
  if (!ctl?.switchProject) { await reply(msg.projectUnavailable); return true; }
  const arg = String(raw ?? '').trim();
  let projectId = null;
  if (arg) {
    const projects = typeof ctl.listProjects === 'function' ? await ctl.listProjects(ref, senderPlatformId) : null;
    if (projects === null) { await reply(msg.projectAccountRequired); return true; }
    const bySlug = projects.find((p) => String(p.slug) === arg);
    if (bySlug) projectId = bySlug.id;
    else if (/^\d+$/.test(arg)) projectId = Number(arg);
  }
  if (projectId === null) { await reply(msg.projectNotFound(arg)); return true; }
  try {
    const { slug } = await ctl.switchProject(ref, senderPlatformId, projectId);
    await reply(msg.projectSwitched(slug));
  } catch (e) {
    await reply(msg.projectError(e?.message ?? e));
  }
  return true;
}