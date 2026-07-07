import { color } from './theme.js';
import { savePrefs } from './prefs.js';
import { appendPromptHistory } from './promptHistory.js';
import { localShellTurn, parseBangCommand, runLocalShell } from './localShell.js';
import { editTextExternally } from './externalEditor.js';
import { composeWithAttachments, expandMentions, MAX_IMAGES_PER_MESSAGE, readClipboardImage, type PendingImage } from './mentions.js';
import { sessionItems, openPicker } from './picker.js';
import { DISABLE_MOUSE, ENABLE_MOUSE } from './layout.js';
import { beginAssistant, pushUser, reduce } from '../../brain/transcript.js';
import { expandPromptCommand } from '../../brain/slashCommands.js';
import type { BrainClient } from './brainClient.js';
import type { ChatRuntime } from './runtime.js';
import type { StreamController } from './streamController.js';
import type { Pickers } from './pickers.js';

/** Local slash-command routing: returns the recognized command (with its argument) or null for a
 *  regular chat message. Pure, so the command surface is unit-testable without a TTY. */
export function parseCommand(text: string): { cmd: 'quit' | 'new' | 'stop' | 'status' | 'restart' | 'sessions' | 'resume' | 'delete' | 'model' | 'reasoning' | 'theme' | 'editor' | 'lsp' | 'mcp' | 'skills' | 'tools' | 'goal' | 'subgoal' | 'compact' | 'plan' | 'build' | 'yolo' | 'paste' | 'help'; arg?: string } | null {
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
    case 'delete': return { cmd: 'delete', arg: m[2] };
    case 'model': return { cmd: 'model', arg: m[2] };
    case 'reasoning': return { cmd: 'reasoning', arg: m[2] };
    case 'theme': return { cmd: 'theme', arg: m[2] };
    case 'editor': return { cmd: 'editor' };
    case 'lsp': return { cmd: 'lsp' };
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

function handleGoalCommand(rt: ChatRuntime, arg?: string): void {
  const { client } = rt;
  const raw = (arg ?? '').trim();
  if (!raw || raw === 'status' || raw === 'show') {
    void client.goal().then((g) => { rt.notice = color.dim(goalSummary(g)); rt.render(); })
      .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
    return;
  }
  if (raw === 'pause' || raw === 'resume' || raw === 'clear') {
    void client.goalAction(raw).then((g) => { rt.notice = color.dim(raw === 'clear' ? 'goal cleared' : goalSummary(g)); rt.render(); })
      .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
    return;
  }
  const draft = raw.startsWith('draft ');
  const text = draft ? raw.slice('draft '.length).trim() : raw;
  rt.notice = color.dim(draft ? 'drafting goal…' : 'starting persistent goal…');
  rt.render();
  void client.setGoal(text, draft).then((g) => { rt.notice = color.dim(draft ? `goal draft:\n${g.draft}` : goalSummary(g)); rt.render(); })
    .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
}

function handleSubgoalCommand(rt: ChatRuntime, arg?: string): void {
  const { client } = rt;
  const raw = (arg ?? '').trim();
  if (!raw) { rt.notice = color.dim('usage: /subgoal <text> · /subgoal remove <N> · /subgoal clear'); rt.render(); return; }
  const remove = /^remove\s+(\d+)$/i.exec(raw);
  const action = raw === 'clear' ? ['clear', undefined] as const : remove ? ['remove', Number(remove[1])] as const : ['add', raw] as const;
  void client.subgoal(action[0], action[1]).then((g) => { rt.notice = color.dim(goalSummary(g)); rt.render(); })
    .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
}

/** Park an image for the next send and surface it in the chip row. */
function attachImage(rt: ChatRuntime, img: PendingImage): void {
  if (rt.pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
    rt.notice = color.error(`max ${MAX_IMAGES_PER_MESSAGE} images per message — send or esc-drop first`);
    return;
  }
  rt.pendingImages = [...rt.pendingImages, img];
  rt.attachmentChips.set(rt.pendingImages);
  rt.notice = color.dim(`${img.name} attached (${Math.max(1, Math.round(img.bytes / 1024))} KB) — sends with your next message`);
}

/** Wire the editor's submit path: the slash-command dispatcher plus the regular send pipeline
 *  (`!` local shell, sub-agent steering, prompt commands, `@` mention expansion, image attachments). */
export function wireSubmit(rt: ChatRuntime, deps: { stream: StreamController; pickers: Pickers }): void {
  const { client, tui, term, editor, attachmentChips, shellContext } = rt;
  const { stream, pickers } = deps;

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
      rt.render();
      void runLocalShell(localCmd, process.cwd()).then((result) => {
        shellContext.add(result);
        rt.view = { ...rt.view, turns: [...rt.view.turns, localShellTurn(result)] };
        if (rt.notice.includes('running locally')) rt.notice = '';
        rt.render();
      });
      return;
    }
    const command = parseCommand(trimmed);
    // Inside a sub-agent view, plain text goes to the CHILD (steered into its running turn, or a fresh
    // child turn when idle) — the reply streams into the open view. Slash commands always act on the
    // parent conversation, so they snap back first (running /new while "inside" a child would be chaos).
    if (rt.childView && !command) {
      const target = rt.childView.sessionId;
      rt.childView.view = pushUser(rt.childView.view, trimmed); // local echo; the store copy lands server-side
      rt.render();
      void client.subagentSend(target, trimmed).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
      return;
    }
    if (rt.childView && command) stream.closeSubagent();
    if (command) {
      switch (command.cmd) {
        case 'quit': rt.quit(); return;
        case 'help': pickers.openHelpModal(); return;
        case 'new':
          void stream.switchTo({ fresh: true }).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          return;
        case 'sessions':
        case 'resume': {
          if (!command.arg) {
            pickers.openSessionsModal();
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? rt.listed[n - 1]?.id : command.arg;
          if (!target) { rt.notice = color.dim('use /resume and pick with the arrows'); rt.render(); return; }
          void stream.switchTo({ session: target }).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
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
            void client.saveTerminalSettings({ showThoughtsCli: rt.showThoughts }).catch(() => { /* offline → local pref still applies */ });
            rt.notice = color.dim(rt.showThoughts ? 'Thought rows shown' : 'Thought rows hidden — /reasoning show brings them back');
            rt.render();
            return;
          }
          if (rt.thinkingLevels.length === 0) { rt.notice = color.dim('this model has no reasoning-effort levels'); rt.render(); return; }
          const apply = (level: string): void => {
            void client.setThinkingLevel(level).then((r) => {
              rt.thinkingLevel = r.thinkingLevel;
              rt.notice = '';
              rt.render();
            }).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          };
          // A bare "/reasoning high" applies directly; "/reasoning" opens the picker over the model's levels.
          if (command.arg && rt.thinkingLevels.includes(command.arg.trim())) { apply(command.arg.trim()); return; }
          pickers.openThinkingPicker();
          return;
        }
        case 'theme': {
          const wanted = command.arg?.trim();
          if (wanted) {
            if (!pickers.applyTheme(wanted)) { rt.notice = color.error(`unknown theme: ${wanted}`); rt.render(); }
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
          term.write(DISABLE_MOUSE);
          tui.stop();
          void editTextExternally({ text: initial }).then((edited) => {
            tui.start();
            term.write(ENABLE_MOUSE);
            editor.setText(edited ?? initial);
            if (edited == null) rt.notice = color.dim('editor exited without saving — draft kept');
            tui.requestRender(true);
            rt.render();
          });
          return;
        }
        case 'delete': {
          const doDelete = (target: string): void => {
            void client.deleteSession(target)
              .then(async () => {
                rt.listed = rt.listed.filter((s) => s.id !== target);
                rt.notice = color.dim('conversation deleted');
                // Rebind only when this client's OWN conversation was deleted — see openSessionsModal.
                if (target === client.boundSession) await stream.switchTo({});
                rt.render();
              })
              .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
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
            void client.sessions().then((list) => {
              rt.listed = list.map((s) => ({ id: s.id, title: s.title }));
              if (list.length === 0) { rt.notice = color.dim('no conversations'); rt.render(); return; }
              openPicker({
                tui, editor, title: 'Delete conversation', items: sessionItems(list, client.boundSession),
                onPick: (id) => confirmDelete(id, list.find((s) => s.id === id)?.title ?? ''),
              });
            }).catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
            return;
          }
          const n = Number(command.arg);
          const target = Number.isInteger(n) && n >= 1 ? rt.listed[n - 1]?.id : command.arg;
          if (!target) { rt.notice = color.dim('use /delete and pick with the arrows'); rt.render(); return; }
          confirmDelete(target, rt.listed.find((s) => s.id === target)?.title ?? '');
          return;
        }
        case 'lsp':
          pickers.openLspModal();
          return;
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
          handleGoalCommand(rt, command.arg);
          return;
        case 'subgoal':
          handleSubgoalCommand(rt, command.arg);
          return;
        case 'compact': {
          rt.notice = color.dim('compacting…');
          rt.render();
          void client.compact()
            .then(async (r) => { if (r.usage) rt.usage = r.usage; await rt.refreshMeta(); rt.notice = color.dim(r.compacted ? 'conversation compacted' : (r.message ?? 'nothing to compact yet')); rt.render(); })
            .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          return;
        }
        case 'plan':
          rt.workMode = 'plan';
          rt.notice = '';
          rt.render();
          return;
        case 'build':
          rt.workMode = 'build';
          rt.notice = '';
          rt.render();
          return;
        case 'yolo': {
          // Session-scoped: "/yolo on|off" forces, bare "/yolo" toggles. The persisted default lives in
          // web Account → Orca AI; this override never outlives the live session.
          const arg = command.arg?.trim().toLowerCase();
          if (arg && arg !== 'on' && arg !== 'off') { rt.notice = color.dim('usage: /yolo · /yolo on · /yolo off'); rt.render(); return; }
          void client.setYolo(arg === 'on' ? true : arg === 'off' ? false : undefined)
            .then((r) => {
              rt.yoloOn = r.yolo;
              rt.notice = r.yolo
                ? color.warning('YOLO on — tool asks auto-approve for this session (deny rules still apply)')
                : color.dim('YOLO off — tool asks prompt for approval again');
              rt.render();
            })
            .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          return;
        }
        case 'paste': {
          // CLI-local: reads THIS machine's clipboard. The image parks as a pending attachment
          // (chip row above the input) and rides along with the next message.
          rt.notice = color.dim('reading the clipboard image…');
          rt.render();
          void readClipboardImage().then((r) => {
            if (r.image) attachImage(rt, r.image);
            else rt.notice = color.error(r.error ?? 'no image on the clipboard');
            rt.render();
          });
          return;
        }
        case 'stop': {
          if (!rt.view.thinking) { rt.notice = color.dim('nothing is running'); rt.render(); return; }
          rt.notice = color.dim('stopping…');
          rt.render();
          void client.abort()
            .then(() => { rt.notice = color.dim('agent stopped'); rt.render(); })
            .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          return;
        }
        case 'status':
          pickers.openStatusModal();
          return;
        case 'restart': {
          rt.notice = color.dim('restarting daemon…');
          rt.render();
          void client.command('restart')
            .then((r) => { rt.notice = color.dim(r?.message ?? 'restarting…'); rt.render(); })
            .catch((e: Error) => { rt.notice = color.error(`error: ${e.message}`); rt.render(); });
          return;
        }
      }
    }
    // A plugin-contributed prompt command (`kind:'prompt'`) that isn't a built-in: expand its template
    // with the typed arguments and send THAT to the agent, while the transcript shows what the user typed.
    const pm = /^\/(\S+)(?:\s+([\s\S]+))?$/.exec(trimmed);
    const promptCmd = pm ? rt.commandDefs.find((c) => c.name === pm[1] && c.kind === 'prompt' && c.prompt) : undefined;
    if (pm && promptCmd) {
      const expanded = expandPromptCommand(promptCmd.prompt ?? '', pm[2] ?? '');
      rt.view = beginAssistant(pushUser(rt.view, trimmed));
      rt.render();
      void client.send(shellContext.take(expanded), rt.workMode).catch((e: Error) => { rt.view = reduce(rt.view, { type: 'error', message: e.message }); rt.render(); });
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
      rt.view = beginAssistant(pushUser(rt.view, echo));
      rt.render();
      // ONE composition path for everything that rides along: buffered `!` shell context first, then
      // the mention attachments, then the user's own words (see composeWithAttachments).
      void client.send(
        shellContext.take(composeWithAttachments(trimmed, mentions.block)),
        rt.workMode,
        images.map((i) => ({ data: i.data, mimeType: i.mimeType })),
      ).catch((e: Error) => { rt.view = reduce(rt.view, { type: 'error', message: e.message }); rt.render(); });
    };
    if (mentions.wantsClipboard) {
      void readClipboardImage().then((r) => {
        if (!r.image) rt.notice = color.error(r.error ?? 'no image on the clipboard');
        sendWith(r.image ? [r.image] : []);
      });
      return;
    }
    sendWith([]);
  };
}
