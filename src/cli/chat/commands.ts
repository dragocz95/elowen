import { color } from './theme.js';
import { savePrefs } from './prefs.js';
import { appendPromptHistory } from './promptHistory.js';
import { localShellTurn, parseBangCommand, runLocalShell } from './localShell.js';
import { editTextExternally } from './externalEditor.js';
import { composeWithAttachments, expandMentions, MAX_IMAGES_PER_MESSAGE, readClipboardImage, type PendingImage } from './mentions.js';
import { sessionItems, openPicker, openTextInput } from './picker.js';
import type { BrainClient } from './brainClient.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources, ChatTaskScope } from './chatCapabilities.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';
import type { Pickers } from './pickers.js';
import { createOptimisticGoal } from './goalState.js';

/** Resolve either PI's canonical reasoning id or its provider-facing label (`ultra` → `xhigh`). */
export function resolveThinkingLevel(value: string, levels: string[], labels: Record<string, string>): string | null {
  const wanted = value.trim().toLowerCase();
  return levels.find((level) => level.toLowerCase() === wanted || (labels[level] ?? '').toLowerCase() === wanted) ?? null;
}

/** Local slash-command routing: returns the recognized command (with its argument) or null for a
 *  regular chat message. Pure, so the command surface is unit-testable without a TTY. */
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'rename' | 'delete' | 'model' | 'reasoning' | 'fast' | 'theme' | 'editor' | 'keybinds' | 'lsp' | 'tdd' | 'mcp' | 'skills' | 'tools' | 'goal' | 'subgoal' | 'compact' | 'plan' | 'build' | 'yolo' | 'paste' | 'export' | 'help'; arg?: string } | null {
  const m = /^\/(\w+)(?:\s+(.+))?$/.exec(text.trim());
  if (!m) return null;
  switch (m[1]) {
    case 'quit': case 'exit': return { cmd: 'quit' };
    case 'new': return { cmd: 'new' };
    case 'stop': return { cmd: 'stop' };
    case 'status': return { cmd: 'status' };
    case 'restart': return { cmd: 'restart' };
    case 'sessions': return { cmd: 'sessions' };
    case 'resume': return { cmd: 'resume', arg: m[2] };
    case 'rename': return { cmd: 'rename', arg: m[2] };
    case 'delete': return { cmd: 'delete', arg: m[2] };
    case 'model': return { cmd: 'model', arg: m[2] };
    case 'reasoning': return { cmd: 'reasoning', arg: m[2] };
    case 'fast': return { cmd: 'fast', arg: m[2] };
    case 'theme': return { cmd: 'theme', arg: m[2] };
    case 'editor': return { cmd: 'editor' };
    case 'keybinds': return { cmd: 'keybinds' };
    case 'lsp': return { cmd: 'lsp' };
    case 'tdd': return { cmd: 'tdd', arg: m[2] };
    case 'mcp': return { cmd: 'mcp' };
    case 'skills': return { cmd: 'skills' };
    case 'tools': return { cmd: 'tools' };
    case 'goal': return { cmd: 'goal', arg: m[2] };
    case 'subgoal': return { cmd: 'subgoal', arg: m[2] };
    case 'compact': return { cmd: 'compact' };
    case 'plan': return { cmd: 'plan', arg: m[2] };
    case 'build': return { cmd: 'build', arg: m[2] };
    case 'yolo': return { cmd: 'yolo', arg: m[2] };
    case 'paste': return { cmd: 'paste' };
    case 'export': return { cmd: 'export', arg: m[2] };
    case 'help': return { cmd: 'help' };
    default: return null;
  }
}

/** True while the input text can still be a slash-command name being typed ("/", "/mo", "/model").
 *  A space (arguments), a second '/' (a path like /var/www/x) or a wiped leading '/' means it's ordinary
 *  input text, so the suggestion overlay should close. Pure — unit-testable without a TTY. */
export function isSlashCommandDraft(text: string): boolean {
  return /^\/[^\s/]*$/.test(text);
}

function goalSummary(g: Awaited<ReturnType<BrainClient['goal']>>): string {
  if (!g) return 'no active goal';
  const bits = [`goal ${g.status}`, `${g.turns_used}/${g.turn_budget} turns`, g.goal];
  try {
    const subs = JSON.parse(g.subgoals) as { text?: string; done?: boolean }[];
    if (Array.isArray(subs) && subs.length) bits.push(`subgoals: ${subs.filter((s) => s?.done).length}/${subs.length}`);
  } catch { /* malformed subgoals JSON → skip the count */ }
  if (g.paused_reason) bits.push(`paused: ${g.paused_reason}`);
  if (g.last_evidence) bits.push(`evidence: ${g.last_evidence}`);
  return bits.join(' · ');
}

function handleGoalCommand(
  rt: ChatState,
  client: BrainClient,
  render: (reason?: string) => void,
  run: ChatTaskScope['runSession'],
  arg?: string,
): void {
  const raw = (arg ?? '').trim();
  const commandRevision = rt.beginGoalCommand();
  const fail = (e: Error): void => {
    if (!rt.isCurrentGoalCommand(commandRevision)) return;
    rt.notice = color.error(`error: ${e.message}`);
    render();
  };
  const publish = (stateRevision: number, goal: Awaited<ReturnType<BrainClient['goal']>>): boolean => {
    if (!rt.isCurrentGoalCommand(commandRevision) || rt.goalRevision !== stateRevision) return false;
    rt.setGoal(goal);
    return true;
  };
  if (!raw || raw === 'status' || raw === 'show') {
    const stateRevision = rt.goalRevision;
    run(() => client.goal(), (g) => {
      if (!rt.isCurrentGoalCommand(commandRevision)) return;
      publish(stateRevision, g);
      rt.notice = color.dim(goalSummary(rt.goal));
      render();
    }, fail);
    return;
  }
  if (raw === 'pause' || raw === 'resume' || raw === 'clear') {
    const stateRevision = rt.goalRevision;
    run(() => client.goalAction(raw), (g) => {
      if (!rt.isCurrentGoalCommand(commandRevision)) return;
      publish(stateRevision, g);
      rt.notice = raw === 'clear'
        ? color.dim('goal cleared')
        : (rt.goal?.status === 'active' ? '' : color.dim(goalSummary(rt.goal)));
      render();
    }, fail);
    return;
  }
  const draft = raw.startsWith('draft ');
  const text = draft ? raw.slice('draft '.length).trim() : raw;
  if (draft) {
    rt.notice = color.dim('drafting goal…');
    render();
    const stateRevision = rt.goalRevision;
    run(() => client.setGoal(text, true), (g) => {
      if (!rt.isCurrentGoalCommand(commandRevision)) return;
      publish(stateRevision, g);
      rt.notice = color.dim(`goal draft:\n${g.draft}`);
      render();
    }, fail);
    return;
  }

  // Goal admission and goal execution are intentionally different clocks. The daemon persists and emits
  // `active` before the kickoff model turn, while this HTTP request resolves only after that turn. Show the
  // admitted state immediately; the stream replaces this provisional object with the durable snapshot.
  const optimistic = createOptimisticGoal(text, client.boundSession);
  const stateRevision = rt.setGoal(optimistic);
  rt.notice = '';
  render('goal:optimistic');
  run(async () => {
    try {
      return { kind: 'confirmed' as const, goal: await client.setGoal(text, false) };
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // setGoal can fail only after the daemon has durably admitted and then paused the replacement.
      // Re-read that authority instead of resurrecting the previous row from local memory. Record the
      // revision AFTER the GET settles: it may legitimately supersede an active SSE that arrived while
      // the POST was failing, but must not overwrite an SSE that arrives after this snapshot.
      try {
        const goal = await client.goal();
        return { kind: 'failed' as const, goal, observedRevision: rt.goalRevision, error };
      } catch {
        return { kind: 'failed' as const, goal: undefined, observedRevision: rt.goalRevision, error };
      }
    }
  }, (result) => {
    if (!rt.isCurrentGoalCommand(commandRevision)) return;
    if (result.kind === 'failed') {
      if (result.goal !== undefined) {
        if (rt.goalRevision === result.observedRevision) rt.setGoal(result.goal);
      } else if (rt.goalRevision === stateRevision) {
        // Neither POST nor reconciliation proved a durable active goal. Clear only our still-current
        // optimistic object so the elapsed timer can never claim work that may not exist server-side.
        rt.setGoal(null);
      }
      rt.notice = color.error(`error: ${result.error.message}`);
      render('goal:failed');
      return;
    }
    const published = publish(stateRevision, result.goal);
    if (!published) return; // a newer stream event or command already owns the visible state
    rt.notice = '';
    render('goal:confirmed');
  });
}

function handleSubgoalCommand(
  rt: ChatState,
  client: BrainClient,
  render: (reason?: string) => void,
  run: ChatTaskScope['runSession'],
  arg?: string,
): void {
  const raw = (arg ?? '').trim();
  if (!raw) { rt.notice = color.dim('usage: /subgoal <text> · /subgoal remove <N> · /subgoal clear'); render(); return; }
  const remove = /^remove\s+(\d+)$/i.exec(raw);
  const action = raw === 'clear' ? ['clear', undefined] as const : remove ? ['remove', Number(remove[1])] as const : ['add', raw] as const;
  const commandRevision = rt.beginGoalCommand();
  const stateRevision = rt.goalRevision;
  run(() => client.subgoal(action[0], action[1]), (g) => {
    if (!rt.isCurrentGoalCommand(commandRevision)) return;
    if (rt.goalRevision === stateRevision) rt.setGoal(g);
    rt.notice = color.dim(goalSummary(rt.goal));
    render();
  }, (e) => {
    if (!rt.isCurrentGoalCommand(commandRevision)) return;
    rt.notice = color.error(`error: ${e.message}`); render();
  });
}

/** Park an image for the next send and surface it in the chip row. */
function attachImage(rt: ChatState, attachmentChips: ChatApplicationResources['attachmentChips'], img: PendingImage): void {
  if (rt.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
    rt.notice = color.error(`max ${MAX_IMAGES_PER_MESSAGE} images per message — send or esc-drop first`);
    return;
  }
  rt.pendingImages = [...rt.pendingImages, img];
  attachmentChips.set(rt.pendingImages);
  rt.notice = color.dim(`${img.name} attached (${Math.max(1, Math.round(img.bytes / 1024))} KB) — sends with your next message`);
}

/** Wire the editor's submit path: the slash-command dispatcher plus the regular send pipeline
 *  (`!` local shell, sub-agent steering, prompt commands, `@` mention expansion, image attachments). */
/** The local notice for a `/compact` result. A REAL compaction (`compacted:true`) is announced entirely
 *  by the daemon's BrainEvent stream (the `notice` + `compacted` events), so the command shows nothing of
 *  its own. A benign no-op (`compacted:false` — nothing to compact yet) emits NO stream event, so its
 *  message must be surfaced here or the command would look like it did nothing. Returns null when the
 *  stream owns the feedback. */
export function compactNotice(result: { compacted: boolean; message?: string }): string | null {
  return result.compacted ? null : (result.message ?? 'Nothing to compact yet.');
}

export function wireSubmit(
  rt: ChatState,
  resources: Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'attachmentChips' | 'shellContext' | 'commandDefs' | 'lifetime'>,
  actions: ChatApplicationActions,
  deps: {
    stream: StreamCoordinatorPort;
    pickers: Pickers;
    runLocalShell?: (command: string, cwd: string, signal: AbortSignal) => ReturnType<typeof runLocalShell>;
    readClipboardImage?: (signal: AbortSignal) => ReturnType<typeof readClipboardImage>;
    editTextExternally?: (options: Parameters<typeof editTextExternally>[0]) => ReturnType<typeof editTextExternally>;
  },
): void {
  const { client, tui, editor, attachmentChips, shellContext, commandDefs, lifetime } = resources;
  const { render, renderForced, refreshMeta, quit, suspendTerminal, resumeTerminal } = actions;
  const { stream, pickers } = deps;
  const runShell = deps.runLocalShell ?? ((command, cwd, signal) => runLocalShell(command, cwd, undefined, signal));
  const readClipboard = deps.readClipboardImage ?? ((signal) => readClipboardImage(undefined, undefined, undefined, signal));
  const editExternal = deps.editTextExternally ?? editTextExternally;
  const runApplication: ChatTaskScope['runApplication'] = (operation, onFulfilled, onRejected) =>
    lifetime.runApplication(operation, onFulfilled, onRejected);
  const runSession: ChatTaskScope['runSession'] = (operation, onFulfilled, onRejected) =>
    lifetime.runSession(operation, onFulfilled, onRejected);
  const fail = (e: Error): void => { rt.notice = color.error(`error: ${e.message}`); render(); };

  editor.onSubmit = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    editor.addToHistory(trimmed); // Up-arrow recall of sent inputs (seeded from disk at startup)
    appendPromptHistory(process.cwd(), trimmed); // per-project persistence for the next session
    editor.setText('');
    rt.notice = '';
    // `!cmd` runs LOCALLY (node child_process in the CLI's cwd) — never sent to the brain. The output
    // renders as a console block and is buffered as context for the NEXT prompt (see LocalShellBuffer).
    const localCmd = parseBangCommand(trimmed);
    if (localCmd) {
      rt.notice = color.dim(`$ ${localCmd} · running locally…`);
      render();
      runSession((signal) => runShell(localCmd, process.cwd(), signal), (result) => {
        shellContext.add(result);
        rt.transcript.appendLocalTurn(localShellTurn(result));
        if (rt.notice.includes('running locally')) rt.notice = '';
        render();
      });
      return;
    }
    const command = parseCommand(trimmed);
    // Inside a sub-agent view, plain text goes to the CHILD (steered into its running turn, or a fresh
    // child turn when idle) — the reply streams into the open view. Slash commands always act on the
    // parent conversation, so they snap back first (running /new while "inside" a child would be chaos).
    if (rt.childView && !command) {
      const target = rt.childView.sessionId;
      // The child daemon stream emits the authoritative `user` event for both a running steer and an
      // idle fresh turn. Do not echo locally: on a running child that produced two identical bubbles.
      render(); // flush the cleared editor while the request reaches the daemon
      runSession(() => client.subagentSend(target, trimmed), () => {}, fail);
      return;
    }
    if (rt.childView && command) stream.closeSubagent();
    if (command) {
      switch (command.cmd) {
        case 'quit': quit(); return;
        case 'help': pickers.openHelpModal(); return;
        case 'new':
          runApplication(() => stream.switchTo({ fresh: true }), () => {}, fail);
          return;
        case 'sessions':
        case 'resume': {
          if (!command.arg) {
            pickers.openSessionsModal();
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? rt.listed[n - 1]?.id : command.arg;
          if (!target) { rt.notice = color.dim('use /resume and pick with the arrows'); render(); return; }
          runApplication(() => stream.switchTo({ session: target }), () => {}, fail);
          return;
        }
        case 'rename': {
          const sessionId = client.boundSession;
          if (!sessionId) { rt.notice = color.error('no active conversation to rename'); render(); return; }
          const apply = (raw: string): void => {
            const title = raw.trim();
            if (!title) { rt.notice = color.error('conversation title cannot be empty'); render(); return; }
            runSession(() => client.renameSession(sessionId, title), (renamed) => {
                rt.conversationTitle = renamed.title;
                rt.notice = color.dim('conversation renamed');
                render();
              }, fail);
          };
          if (command.arg) apply(command.arg);
          else openTextInput({ tui, editor, title: 'Rename conversation', initial: rt.conversationTitle, onSubmit: apply });
          return;
        }
        case 'model': {
          pickers.openModelPicker();
          return;
        }
        case 'reasoning': {
          // "/reasoning show" toggles the Thought rows — persisted per USER server-side (cross-device,
          // mirrors the Account → Terminal switch) with the local pref as offline fallback.
          if (command.arg?.trim() === 'show') {
            rt.showThoughts = !rt.showThoughts;
            savePrefs({ showThoughts: rt.showThoughts });
            runApplication(() => client.saveTerminalSettings({ showThoughtsCli: rt.showThoughts }), () => {}, () => { /* offline → local pref still applies */ });
            rt.notice = color.dim(rt.showThoughts ? 'Thought rows shown' : 'Thought rows hidden — /reasoning show brings them back');
            render();
            return;
          }
          if (rt.thinkingLevels.length === 0) { rt.notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
          const apply = (level: string): void => {
            runSession(() => client.setThinkingLevel(level), (r) => {
              rt.thinkingLevel = r.thinkingLevel;
              rt.notice = '';
              render();
            }, fail);
          };
          // A bare "/reasoning high" applies directly; "/reasoning" opens the picker over the model's levels.
          const direct = command.arg ? resolveThinkingLevel(command.arg, rt.thinkingLevels, rt.thinkingLevelLabels) : null;
          if (direct) { apply(direct); return; }
          pickers.openThinkingPicker();
          return;
        }
        case 'fast': {
          const arg = command.arg?.trim().toLowerCase();
          if (arg === 'status') {
            rt.notice = rt.fastAvailable
              ? color.dim(`fast mode ${rt.fastOn ? 'on' : 'off'}`)
              : color.dim('fast mode is not available for this model/account');
            render();
            return;
          }
          if (arg && arg !== 'on' && arg !== 'off') { rt.notice = color.dim('usage: /fast · /fast on · /fast off · /fast status'); render(); return; }
          if (!rt.fastAvailable) { rt.notice = color.dim('fast mode is not available for this model/account'); render(); return; }
          runSession(() => client.setFast(arg === 'on' ? true : arg === 'off' ? false : undefined), (r) => {
              rt.fastOn = r.fast;
              rt.fastAvailable = r.fastAvailable;
              rt.notice = color.dim(`fast mode ${r.fast ? 'on' : 'off'}`);
              render();
            }, fail);
          return;
        }
        case 'theme': {
          const wanted = command.arg?.trim();
          if (wanted) {
            if (!pickers.applyTheme(wanted)) { rt.notice = color.error(`unknown theme: ${wanted}`); render(); }
            return;
          }
          pickers.openThemePicker();
          return;
        }
        case 'editor': {
          // $VISUAL/$EDITOR (fallback vi) over the current draft: suspend the TUI so the editor owns
          // the terminal, then re-init and load the saved content into the input. Non-zero exit (:cq,
          // crash) keeps the original draft untouched.
          const initial = editor.getExpandedText();
          // Hand the primary buffer to $EDITOR: leave our alternate screen too, or the editor opens
          // nested inside it and its own screen handling fights ours. Re-enter it when we resume.
          suspendTerminal();
          runApplication(async (signal) => {
            try {
              return await editExternal({ text: initial, signal });
            } finally {
              // A temp-dir failure rejects before externalEditor reaches its own cleanup block. The
              // application still owns the suspended terminal and must reclaim it on every outcome.
              if (!signal.aborted) resumeTerminal();
            }
          }, (edited) => {
            editor.setText(edited ?? initial);
            if (edited == null) rt.notice = color.dim('editor exited without saving — draft kept');
            renderForced('external-editor:return');
          }, (e) => {
            editor.setText(initial);
            rt.notice = color.error(`editor failed: ${e.message} — draft kept`);
            renderForced('external-editor:return');
          });
          return;
        }
        case 'delete': {
          const doDelete = (target: string): void => {
            runApplication(async () => {
              await client.deleteSession(target);
              if (target === client.boundSession) await stream.switchTo({});
            }, () => {
                rt.listed = rt.listed.filter((s) => s.id !== target);
                rt.notice = color.dim('conversation deleted');
                render();
              }, fail);
          };
          // Deleting is destructive → always a two-step picker: choose the conversation, then confirm.
          const confirmDelete = (id: string, title: string): void => {
            openPicker({
              tui, editor, title: `Delete "${title || '(untitled)'}"?`,
              items: [
                { value: 'no', label: 'Cancel', description: 'keep the conversation' },
                { value: 'yes', label: 'Delete', description: 'cannot be undone' },
              ],
              onPick: (v) => { if (v === 'yes') doDelete(id); },
            });
          };
          if (!command.arg) {
            runApplication(() => client.sessions(), (list) => {
              rt.listed = list.map((s) => ({ id: s.id, title: s.title }));
              if (list.length === 0) { rt.notice = color.dim('no conversations'); render(); return; }
              openPicker({
                tui, editor, title: 'Delete conversation', items: sessionItems(list, client.boundSession),
                onPick: (id) => confirmDelete(id, list.find((s) => s.id === id)?.title ?? ''),
              });
            }, fail);
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? rt.listed[n - 1]?.id : command.arg;
          if (!target) { rt.notice = color.dim('use /delete and pick with the arrows'); render(); return; }
          confirmDelete(target, rt.listed.find((s) => s.id === target)?.title ?? '');
          return;
        }
        case 'keybinds':
          pickers.openKeybindsModal();
          return;
        case 'lsp':
          pickers.openLspModal();
          return;
        case 'tdd': {
          // Global (daemon-wide) TDD mission mode: bare "/tdd" reports the current state, "/tdd on|off"
          // flips it. Admin-gated server-side — a non-admin's PUT /config 403s, surfaced clearly.
          const arg = command.arg?.trim().toLowerCase();
          if (arg && arg !== 'on' && arg !== 'off') { rt.notice = color.dim('usage: /tdd · /tdd on · /tdd off'); render(); return; }
          const report = (on: boolean): void => {
            rt.notice = on
              ? color.warning('TDD mission mode on — autopilot workers write a failing test first, then implement, then verify')
              : color.dim('TDD mission mode off');
            render();
          };
          if (!arg) {
            runApplication(() => client.getTddMode(), report, fail);
            return;
          }
          const on = arg === 'on';
          runApplication(() => client.setTddMode(on), () => report(on), fail);
          return;
        }
        case 'mcp':
          pickers.openMcpModal();
          return;
        case 'skills':
          pickers.openSkillsModal();
          return;
        case 'tools':
          pickers.openToolsModal();
          return;
        case 'goal':
          handleGoalCommand(rt, client, render, runSession, command.arg);
          return;
        case 'subgoal':
          handleSubgoalCommand(rt, client, render, runSession, command.arg);
          return;
        case 'compact': {
          // The daemon's BrainEvent stream is the SINGLE source of status for a REAL compaction: the
          // compaction `notice` ('compacting context…' → cleared) drives the one status line and the
          // `compacted` event rebuilds the transcript (both handled by StreamCoordinator) — identical to
          // auto-compact and to the web dock. So on a real compaction this handler only refreshes the
          // local usage/meta and paints no line of its own (that used to double up with the stream's).
          // A benign no-op (`compacted:false` — nothing to compact yet) emits NO stream event, so surface
          // the server's message here; a hard failure has no stream event either, so keep the .catch.
          runSession(async () => {
            const result = await client.compact();
            await refreshMeta();
            return result;
          }, (r) => {
              if (r.usage) rt.usage = r.usage;
              const notice = compactNotice(r);
              if (notice) rt.notice = notice;
              render();
            }, fail);
          return;
        }
        case 'export': {
          // Download the CURRENT conversation to the launch directory as a self-contained HTML
          // transcript (default) or a JSONL session file — the CLI mirror of the web Sessions download.
          const arg = command.arg?.trim().toLowerCase();
          if (arg && arg !== 'html' && arg !== 'jsonl') { rt.notice = color.dim('usage: /export · /export html · /export jsonl'); render(); return; }
          const format = arg === 'jsonl' ? 'jsonl' : 'html';
          rt.notice = color.dim(`exporting conversation as ${format}…`);
          render();
          runSession(() => client.exportSession(format), (path) => { rt.notice = color.success(`saved ${path}`); render(); }, fail);
          return;
        }
        case 'plan':
          rt.workMode = 'plan';
          rt.notice = '';
          render();
          return;
        case 'build':
          rt.workMode = 'build';
          rt.notice = '';
          render();
          return;
        case 'yolo': {
          // Session-scoped: "/yolo on|off" forces, bare "/yolo" toggles. The persisted default lives in
          // web Account → Elowen AI; this override never outlives the live session.
          const arg = command.arg?.trim().toLowerCase();
          if (arg && arg !== 'on' && arg !== 'off') { rt.notice = color.dim('usage: /yolo · /yolo on · /yolo off'); render(); return; }
          runSession(() => client.setYolo(arg === 'on' ? true : arg === 'off' ? false : undefined), (r) => {
              rt.yoloOn = r.yolo;
              rt.notice = r.yolo
                ? color.warning('YOLO on — tool asks auto-approve for this session (deny rules still apply)')
                : color.dim('YOLO off — tool asks prompt for approval again');
              render();
            }, fail);
          return;
        }
        case 'paste': {
          // CLI-local: reads THIS machine's clipboard. The image parks as a pending attachment
          // (chip row above the input) and rides along with the next message.
          rt.notice = color.dim('reading the clipboard image…');
          render();
          runSession((signal) => readClipboard(signal), (r) => {
            if (r.image) attachImage(rt, attachmentChips, r.image);
            else rt.notice = color.error(r.error ?? 'no image on the clipboard');
            render();
          });
          return;
        }
        case 'stop': {
          if (!rt.transcript.thinking) { rt.notice = color.dim('nothing is running'); render(); return; }
          rt.notice = color.dim('stopping…');
          render();
          runSession(() => client.abort(), () => { rt.notice = color.dim('agent stopped'); render(); }, fail);
          return;
        }
        case 'status':
          pickers.openStatusModal();
          return;
        case 'restart': {
          rt.notice = color.dim('restarting daemon…');
          render();
          runApplication(() => client.command('restart'), (r) => { rt.notice = color.dim(r?.message ?? 'restarting…'); render(); }, fail);
          return;
        }
      }
    }
    // A plugin-contributed prompt command (`kind:'prompt'`) that isn't a built-in: send the RAW `/name args`
    // slash so the daemon hands it to PI, which expands the template's arguments natively. It rides alone
    // (no buffered `!` shell context) so the message starts with the slash — PI only expands then. The
    // DAEMON renders the user's turn authoritatively (the `user` stream event), so `/name args` is exactly
    // what the transcript shows. Render now to flush the cleared input.
    const pm = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    const promptCmd = pm ? commandDefs.find((c) => c.name === pm[1] && c.kind === 'prompt' && c.prompt) : undefined;
    if (pm && promptCmd) {
      render();
      runSession(() => client.send(trimmed, rt.workMode), () => {}, (e) => { rt.transcript.apply({ type: 'error', message: e.message }); render(); });
      return;
    }
    // `@path` mentions expand HERE, not in the visible transcript: text files ride inside the prompt
    // as fenced blocks, image files (and `@clipboard`) go out as image content blocks. The user block
    // and the recall history keep the clean text with its @tokens.
    const mentions = expandMentions(trimmed, process.cwd());
    const sendWith = (clipboardImages: PendingImage[]): void => {
      const all = [...rt.pendingImages, ...mentions.images, ...clipboardImages];
      const images = all.slice(0, MAX_IMAGES_PER_MESSAGE);
      if (all.length > images.length) rt.notice = color.warning(`only ${MAX_IMAGES_PER_MESSAGE} images per message — ${all.length - images.length} dropped`);
      rt.pendingImages = [];
      attachmentChips.set([]);
      const echo = images.length ? `${trimmed}\n${images.map((i) => `[📎 ${i.name}]`).join(' ')}` : trimmed;
      // The DAEMON renders the user's turn authoritatively (the `user` stream event) — no optimistic push,
      // so a mid-turn send that queues server-side can't drop or double-render it. `echo` rides as the
      // clean display (the sent text carries the expanded @mention/attachment blocks). Render now to flush
      // the cleared input line + attachment chips (the 'you' bubble follows from the daemon's `user` event).
      render();
      // ONE composition path for everything that rides along: buffered `!` shell context first, then
      // the mention attachments, then the user's own words (see composeWithAttachments).
      runSession(() => client.send(
        shellContext.take(composeWithAttachments(trimmed, mentions.block)),
        rt.workMode,
        images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
        echo,
      ), () => {}, (e) => { rt.transcript.apply({ type: 'error', message: e.message }); render(); });
    };
    if (mentions.wantsClipboard) {
      runSession((signal) => readClipboard(signal), (r) => {
        if (!r.image) rt.notice = color.error(r.error ?? 'no image on the clipboard');
        sendWith(r.image ? [r.image] : []);
      });
      return;
    }
    sendWith([]);
  };
}
