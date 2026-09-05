import { chatThemeItems, color, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { savePrefs } from './prefs.js';
import { sessionItems, modelItems, parseModelValue, openPicker, openTextInput } from './picker.js';
import { resolveModelQuery } from './fuzzy.js';
import { chdirFailure, gitBranch, prettyCwd, resolveCdTarget } from './projectDir.js';
import { loadMentionFrecency } from './mentions.js';
import { isCtrlD, isCtrlL, isCtrlP, isCtrlR, isCtrlU, isTabKey } from './keys.js';
import { openKeybindsEditor } from './keybindsEditor.js';
import { openStatuslineEditor } from './statuslineEditor.js';
import { openStatsOverlay } from './statsOverlay.js';
import { API_KEY_PROVIDERS } from '../setup/constants.js';
import { trimTrailingSlash } from '../../shared/url.js';
import { todoCard } from '../../shared/todoCard.js';
import { TODO_CARD_ID } from '../../shared/chatPresentation.js';
import {
  SandboxRouteError, WORK_MODE_LABEL,
  type BrainProviderView, type SandboxOverview, type SandboxWorkspaceView, type SessionTaskView,
} from './brainClient.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources, ChatTaskScope } from './chatCapabilities.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';

export interface Pickers {
  openThinkingPicker(): void;
  cycleThinkingLevel(): void;
  openModelPicker(): void;
  applyModelArg(arg: string): void;
  /** `/cd [path]` — move the CLI's working directory, or report it when called with no argument. */
  changeDirectory(arg?: string): void;
  applyTheme(name: string): boolean;
  openThemePicker(): void;
  openHelpModal(): void;
  /** `/stats` opens on the conversation section; `/context` passes 'context' to land on the breakdown. */
  openStatsModal(section?: 'conversation' | 'models' | 'context'): void;
  openSessionsModal(): void;
  openMcpModal(): void;
  openSkillsModal(): void;
  openTasksModal(): void;
  /** The per-task action sheet on its own — what a click on a Todo card row opens, without the list. */
  openTaskActions(taskId: string): void;
  /** `/sandbox` — the terminal's chooser for the workspace commands the sandbox plugin declares. */
  openSandboxModal(): void;
  openLspModal(): void;
  openToolsModal(): void;
  openKeybindsModal(): void;
  openStatuslineModal(): void;
}

/** Readable English for the codes the sandbox plugin refuses a workspace operation with. Nothing here
 *  decides anything — the plugin already made the call and left the workspace untouched; this only says
 *  why, because a bare code in a notice tells the user nothing about their own work. */
const SANDBOX_REFUSALS: Record<string, string> = {
  workspace_in_use: 'a process is still running in it',
  workspace_not_clean: 'it holds uncommitted changes, untracked files or commits beyond its base ref',
  workspace_changed: 'it changed after the removal preview was taken',
  workspace_not_found: 'it no longer exists',
  workspace_orphaned: 'its source Project is gone, so the workspace is preserved on disk',
  project_forbidden: 'its Project is no longer accessible to this account',
  session_forbidden: 'the conversation does not belong to this account',
  account_required: 'a linked Elowen account is required',
};

function sandboxReason(error: Error): string | null {
  return error instanceof SandboxRouteError ? SANDBOX_REFUSALS[error.code] ?? null : null;
}

/** One glanceable line of workspace state for a list row. */
function sandboxStateSummary(workspace: SandboxWorkspaceView): string {
  const status = workspace.status;
  if (!status) return 'no Git status';
  const bits = [
    status.dirty > 0 ? `${status.dirty} changed` : null,
    status.untracked > 0 ? `${status.untracked} untracked` : null,
    workspace.uniqueCommits > 0 ? `${workspace.uniqueCommits} own commit${workspace.uniqueCommits === 1 ? '' : 's'}` : null,
    status.ahead > 0 ? `${status.ahead} ahead` : null,
    status.behind > 0 ? `${status.behind} behind` : null,
    workspace.activeProcesses > 0 ? `${workspace.activeProcesses} running` : null,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(' · ') : 'clean';
}

/** Everything the picker/modal surface of the chat offers: model + provider management, reasoning
 *  effort, themes, and the /sessions /mcp /skills /lsp /tools /stats /help modals. */
export function createPickers(
  rt: ChatState,
  resources: Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'termSettings' | 'cwdLabel' | 'branchLabel' | 'commandDefs' | 'lifetime' | 'mentionIndex'>,
  actions: Pick<ChatApplicationActions, 'render' | 'refreshMeta'>,
  stream: StreamCoordinatorPort,
  shell: {
    /** Re-open the telemetry panel so a theme switch recolors it, keeping its hidden state. */
    reshowPanel(): void;
    /** Live-apply a /keybinds rebind to the running session (no restart). */
    reloadKeymap(): void;
  },
): Pickers {
  // cwdLabel/branchLabel are deliberately NOT destructured: `/cd` rewrites them on `resources`, and a
  // local copy taken once at construction would keep reporting the directory the session started in.
  const { client, tui, editor, termSettings, commandDefs, lifetime, mentionIndex } = resources;
  const { render, refreshMeta } = actions;
  const runApplication: ChatTaskScope['runApplication'] = (operation, onFulfilled, onRejected) =>
    lifetime.runApplication(operation, onFulfilled, onRejected);
  const runSession: ChatTaskScope['runSession'] = (operation, onFulfilled, onRejected) =>
    lifetime.runSession(operation, onFulfilled, onRejected);
  const fail = (e: Error): void => { rt.notice = color.error(`error: ${e.message}`); render(); };

  const applyThinkingLevel = (level: string): void => {
    runSession(() => client.setThinkingLevel(level), (r) => {
      rt.thinkingLevel = r.thinkingLevel;
      rt.notice = color.dim(`reasoning effort: ${rt.thinkingLevelLabels[r.thinkingLevel] ?? r.thinkingLevel}`);
      render();
    }, fail);
  };

  const openThinkingPicker = (): void => {
    if (rt.thinkingLevels.length === 0) { rt.notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
    openPicker({
      tui, editor, title: 'Reasoning effort',
      items: rt.thinkingLevels.map((lv) => {
        const label = rt.thinkingLevelLabels[lv] ?? lv;
        const raw = label === lv ? '' : lv;
        return { value: lv, label, description: [raw, lv === rt.thinkingLevel ? 'current' : ''].filter(Boolean).join(' · ') || undefined };
      }),
      onPick: (value) => applyThinkingLevel(value),
    });
  };

  // ctrl+r: cycle the reasoning effort in place — popping a modal for a one-key toggle just interrupts
  // the user's typing. The /think command still opens the explicit picker. The local level advances
  // OPTIMISTICALLY so rapid presses step through the levels instead of re-sending the same target
  // (the server reply is authoritative; an error rolls back).
  const cycleThinkingLevel = (): void => {
    if (rt.thinkingLevels.length === 0) { rt.notice = color.dim('this model has no reasoning-effort levels'); render(); return; }
    const previous = rt.thinkingLevel;
    const next = rt.thinkingLevels[(rt.thinkingLevels.indexOf(rt.thinkingLevel) + 1) % rt.thinkingLevels.length]!;
    rt.thinkingLevel = next;
    rt.notice = color.dim(`reasoning effort: ${rt.thinkingLevelLabels[next] ?? next}`);
    render();
    runSession(
      () => client.setThinkingLevel(next),
      (r) => { rt.thinkingLevel = r.thinkingLevel; rt.notice = color.dim(`reasoning effort: ${rt.thinkingLevelLabels[r.thinkingLevel] ?? r.thinkingLevel}`); render(); },
      (e) => { rt.thinkingLevel = previous; fail(e); },
    );
  };

  // /model → ctrl+p: manage brain providers right from the CLI. Presets come from the setup wizard's
  // curated endpoint catalog; a custom OpenAI-compatible URL, the API key and (for openai-type entries)
  // the wire API (Responses vs Chat Completions) are collected step by step through the same modals.
  const openProviderModal = (): void => {
    runApplication(() => client.brainProviders(), (providers) => {
      const apiLabel = (p: BrainProviderView): string => p.type !== 'openai' ? '' : ` · ${p.api ?? 'auto'} API`;
      const saveAll = (next: BrainProviderView[], done: string): void => {
        runApplication(() => client.saveBrainProviders(next), () => { rt.notice = color.dim(done); render(); }, fail);
      };
      // Per-entry API mode picker (openai-type only): auto / responses / completions.
      const openApiPicker = (p: BrainProviderView, all: BrainProviderView[]): void => {
        const officialOpenAi = /api\.openai\.com/.test(p.baseUrl || 'https://api.openai.com/v1');
        openPicker({
          tui, editor, title: `${p.label} · wire API`,
          items: [
            { value: 'auto', label: 'Auto (recommended)', description: officialOpenAi ? 'OpenAI endpoint → Responses API' : 'OpenAI-compatible endpoint → Chat Completions' },
            { value: 'openai-responses', label: 'Responses API', description: 'prompt caching + reasoning summaries (needs endpoint support)' },
            { value: 'openai-completions', label: 'Chat Completions', description: 'the ubiquitous OpenAI-compatible API' },
          ],
          onPick: (v) => {
            const next = { ...p };
            if (v === 'auto') delete next.api; else next.api = v as 'openai-responses' | 'openai-completions';
            // In-place update — order is load-bearing (providers[0] is the default for users with no
            // saved model), so an edit must never move the entry to the end.
            const replaced = all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? next : x)) : [...all, next];
            saveAll(replaced, `${p.label}: ${v === 'auto' ? 'auto' : v} · /model to pick a model`);
          },
        });
      };
      const addEntry = (label: string, type: 'openai' | 'anthropic', baseUrl: string): void => {
        openTextInput({
          tui, editor, title: `${label} · API key`,
          onSubmit: (key) => {
            const apiKey = key.trim();
            if (!apiKey) { rt.notice = color.dim('cancelled — no API key entered'); render(); return; }
            const idBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'provider';
            let id = idBase;
            for (let i = 2; providers.some((x) => x.id === id); i++) id = `${idBase}-${i}`;
            const entry: BrainProviderView = { id, label, type, baseUrl, models: [], apiKey };
            if (type === 'openai') openApiPicker(entry, providers);
            else saveAll([...providers, entry], `${label} connected · /model to pick a model`);
          },
        });
      };
      openPicker({
        tui, editor, title: 'Brain providers',
        items: [
          { value: '__add', label: '+ Add provider', description: 'curated endpoints or a custom URL' },
          ...providers.map((p) => ({
            value: p.id,
            label: p.label,
            description: `${p.type.startsWith('oauth-') ? 'OAuth account' : (p.baseUrl || 'https://api.openai.com/v1')}${apiLabel(p)}`,
          })),
        ],
        footer: 'enter open · type to search · esc close',
        onPick: (v) => {
          if (v === '__add') {
            openPicker({
              tui, editor, title: 'Add provider',
              items: [
                ...API_KEY_PROVIDERS.map((p) => ({ value: p.key, label: p.label, description: p.base })),
                { value: '__custom', label: 'Custom OpenAI-compatible endpoint', description: 'any /v1 base URL' },
              ],
              footer: 'enter pick · type to search · esc close',
              onPick: (key) => {
                if (key === '__custom') {
                  openTextInput({
                    tui, editor, title: 'Custom endpoint · base URL (…/v1)',
                    onSubmit: (url) => {
                      const baseUrl = trimTrailingSlash(url.trim());
                      if (!/^https?:\/\//.test(baseUrl)) { rt.notice = color.error('a base URL must start with http(s)://'); render(); return; }
                      addEntry(new URL(baseUrl).hostname, 'openai', baseUrl);
                    },
                  });
                  return;
                }
                const preset = API_KEY_PROVIDERS.find((p) => p.key === key);
                if (preset && (preset.type === 'openai' || preset.type === 'anthropic')) addEntry(preset.label, preset.type, preset.base);
              },
            });
            return;
          }
          const p = providers.find((x) => x.id === v);
          if (!p) return;
          if (p.type !== 'openai') { rt.notice = color.dim(`${p.label}: nothing to configure here (manage models via the web settings)`); render(); return; }
          openApiPicker(p, providers);
        },
      });
    }, fail);
  };

  // Apply a concrete (provider, model) switch and reopen the event stream — the server rebuilt the
  // session, so the old stream is dead. Shared by the picker and the `/model <name>` fast path.
  const applyModel = (sel: { provider: string; model: string }): void => {
    rt.notice = color.dim('switching model…');
    render();
    runSession(() => client.setModel(sel), (r) => {
      rt.modelName = r.model;
      stream.restartStream();
      runSession(() => refreshMeta(), () => { rt.notice = ''; render(); }, fail);
    }, fail);
  };

  // `/cd [path]`: move the CLI's working directory, or report it when called bare.
  //
  // `process.chdir` is the whole mechanism, on purpose. The cwd sent on every /brain/start and
  // /brain/send, `!` shell commands, `@` expansion, /export and prompt-history persistence all read
  // `process.cwd()` when they run, so one chdir moves all of them and none needs to know about `/cd`.
  // The daemon needs no change either: it already lets a per-turn client cwd beat the session's own.
  //
  // Three things snapshot the directory at boot and cannot follow by themselves — the status chips, the
  // `@` file index and mention ranking — so they are re-derived here. `process.chdir` reports a missing
  // directory, a file and a permission failure itself, with the errno worth showing.
  const changeDirectory = (arg?: string): void => {
    const target = arg?.trim() ? resolveCdTarget(arg) : null;
    if (target) {
      try {
        process.chdir(target);
      } catch (e) {
        rt.notice = color.error(`cannot enter ${target}: ${chdirFailure(e)}`);
        render();
        return;
      }
      const moved = process.cwd();
      resources.cwdLabel = prettyCwd(moved);
      resources.branchLabel = gitBranch(moved);
      mentionIndex.setCwd(moved);
      rt.mentionFrecency = loadMentionFrecency(moved);
      // Tell the agent too: it was handed a working directory when its session spawned and would
      // otherwise keep describing the old one until something respawned it.
      // Best-effort: the local move already happened and every later turn reports it regardless. A daemon
      // that refuses (no live conversation yet, a directory outside a scoped policy) costs only the marker.
      runApplication(() => client.setWorkDir(moved), () => { /* marker recorded */ }, () => { /* see above */ });
    }
    rt.notice = color.dim(`${resources.cwdLabel}${resources.branchLabel ? ` · ${resources.branchLabel}` : ''}`);
    render();
  };

  // `/model <name>`: fuzzy-fix the argument to a configured model and switch directly; on no confident
  // match, fall back to the picker so the user can choose (never silently jump to a surprising model).
  const applyModelArg = (arg: string): void => {
    runApplication(() => client.models(), (models) => {
      const hit = resolveModelQuery(models, arg);
      if (hit) { applyModel(hit); return; }
      rt.notice = color.dim(`no model matches "${arg.trim()}" — pick one`);
      render();
      openModelPicker();
    }, (e) => { rt.notice = color.error(`error: ${e.message}`); render(); });
  };

  const openModelPicker = (): void => {
    runApplication(() => client.models(), (models) => {
      if (models.length === 0) { rt.notice = color.dim('no models configured — ctrl+p in /model adds a provider'); render(); return; }
      openPicker({
        tui, editor, title: 'Switch model', items: modelItems(models, rt.modelName, rt.provider),
        footer: 'enter switch · type to search · ctrl+p providers · esc close',
        onInput: (data, _selected, close) => {
          if (isCtrlP(data)) { close(); openProviderModal(); return true; }
          return false;
        },
        onPick: (value) => { applyModel(parseModelValue(value)); },
      });
    }, (e) => { rt.notice = color.error(`error: ${e.message}`); render(); });
  };

  const applyTheme = (name: string): boolean => {
    // "custom" = the web Account → Terminal palette (offered only when one is configured): re-apply it
    // and persist the choice so startup keeps preferring it on this machine.
    if (name === 'custom' && termSettings?.theme === 'custom' && termSettings.palette) {
      setCustomChatTheme(termSettings.palette);
      savePrefs({ theme: 'custom' });
      editor.borderColor = color.faint;
      rt.notice = color.dim('theme: Custom (web palette)');
      shell.reshowPanel();
      render();
      return true;
    }
    if (!isChatThemeName(name)) return false;
    const theme = setChatTheme(name);
    savePrefs({ theme: name });
    editor.borderColor = color.faint;
    rt.notice = color.dim(`theme: ${theme.label}`);
    shell.reshowPanel();
    render();
    return true;
  };

  const openThemePicker = (): void => {
    const webCustom = termSettings?.theme === 'custom' && termSettings.palette
      ? [{ value: 'custom', label: 'Custom', description: 'your web Account → Terminal palette' }]
      : [];
    openPicker({
      tui, editor, title: 'Terminal theme',
      items: [...webCustom, ...chatThemeItems()],
      onPick: (value) => { applyTheme(value); },
    });
  };

  // /help as an interactive modal in the CLI pattern: an arrow-key list of every command; Enter runs the
  // highlighted one (routed back through the normal submit path), type to filter, esc closes.
  const openHelpModal = (): void => {
    openPicker({
      tui, editor, title: 'Commands',
      items: commandDefs.map((c) => ({ value: c.name, label: `/${c.name}`, description: c.description })),
      footer: 'enter run · type to filter · esc close',
      onPick: (name) => { editor.onSubmit?.(`/${name}`); },
    });
  };

  // /stats as an interactive overlay with ←→-switchable sections: Conversation (the session rows the
  // retired /status used to own, plus this conversation's usage), per-model totals and the context
  // breakdown. `/context` opens the SAME overlay straight on the breakdown section.
  const openStatsModal = (section?: 'conversation' | 'models' | 'context'): void => {
    runSession(() => Promise.all([
      client.status().catch(() => null),
      client.usageByModel().catch(() => null),
      client.contextBreakdown().catch(() => null),
      client.goal().catch(() => null),
    ]), ([s, models, context, goal]) => {
      openStatsOverlay({
        tui, editor, section,
        data: {
          model: s?.model ?? null,
          usage: s?.usage ?? null,
          models: models ?? [],
          context: context ?? null,
          session: {
            ...(s?.title ? { title: s.title } : {}),
            ...(s?.thinkingLevel ? { reasoning: s.thinkingLevelLabels?.[s.thinkingLevel] ?? s.thinkingLevel } : {}),
            // Only offered when the model/account actually has priority processing — otherwise the row
            // would claim "off" for something that was never available.
            ...(s?.fastAvailable ? { fast: s.fast === true } : {}),
            mode: WORK_MODE_LABEL[rt.workMode],
            cwd: resources.cwdLabel,
            ...(resources.branchLabel ? { branch: resources.branchLabel } : {}),
            ...(goal ? { goal: {
              status: goal.status,
              turnsUsed: goal.turns_used,
              turnBudget: goal.turn_budget,
              ...(goal.paused_reason ? { pausedReason: goal.paused_reason } : {}),
            } } : {}),
          },
        },
      });
    }, fail);
  };

  const openSessionsModal = (): void => {
    runApplication(() => client.sessions(), (list) => {
      rt.listed = list.map((s) => ({ id: s.id, title: s.title }));
      if (list.length === 0) { rt.notice = color.dim('no conversations'); render(); return; }
      const refresh = () => openSessionsModal();
      const confirmDelete = (id: string, title: string, current: boolean): void => {
        openPicker({
          tui, editor, title: `Delete "${title || '(untitled)'}"?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the conversation' },
            { value: 'yes', label: 'Delete', description: 'also removes goal state for this session' },
          ],
          onPick: (v) => {
            if (v !== 'yes') { refresh(); return; }
            runApplication(async () => {
              await client.deleteSession(id);
              if (current) await stream.switchTo({});
            }, () => {
              rt.notice = color.dim('conversation deleted');
              refresh();
              render();
            }, fail);
          },
        });
      };
      openPicker({
        tui, editor, title: 'Conversations', items: sessionItems(list, client.boundSession),
        footer: 'enter resume · ctrl+r rename · ctrl+d delete · esc close',
        onPick: (id) => runApplication(() => stream.switchTo({ session: id }), () => {}, fail),
        onInput: (data, item, close) => {
          if (!item) return false;
          const row = list.find((s) => s.id === item.value);
          if (!row) return false;
          if (isCtrlD(data)) { close(); confirmDelete(row.id, row.title, row.id === client.boundSession); return true; }
          if (isCtrlR(data)) {
            close();
            openTextInput({
              tui, editor, title: 'Rename conversation', initial: row.title,
              onSubmit: (title) => {
                runSession(() => client.renameSession(row.id, title), (renamed) => {
                  if (row.id === client.boundSession) rt.conversationTitle = renamed.title;
                  rt.notice = color.dim('conversation renamed'); refresh(); render();
                }, fail);
              },
            });
            return true;
          }
          return false;
        },
      });
    }, fail);
  };

  const openMcpModal = (): void => {
    runApplication(() => client.mcpServers(), (servers) => {
      const items = servers.map((s) => ({
        value: s.name,
        label: `${s.status === 'connected' ? color.success('●') : s.status === 'connecting' ? color.warning('●') : color.faint('○')} ${s.name}`,
        description: `${s.transport} · ${s.toolCount} tools${s.lastError ? ` · ${s.lastError}` : ''}`,
      }));
      if (items.length === 0) { rt.notice = color.dim('no MCP servers configured'); render(); return; }
      const refresh = () => openMcpModal();
      const reconnect = (name: string): void => {
        rt.notice = color.dim(`reconnecting ${name}…`); render();
        runApplication(() => client.reconnectMcp(name), () => { rt.notice = color.dim(`MCP ${name} connected`); refresh(); render(); }, fail);
      };
      const detail = (name: string): void => {
        const server = servers.find((s) => s.name === name);
        if (!server) return;
        const rows = [
          { value: '__back', label: 'Back', description: 'return to servers' },
          { value: '__reconnect', label: 'Reconnect', description: server.status === 'connected' ? 'already connected' : 'try reconnect' },
          ...server.tools.map((tool) => ({
            value: tool.name,
            label: tool.name,
            description: `${tool.description ?? ''}${tool.schema ? ' · schema available' : ''}`.trim(),
          })),
        ];
        openPicker({ tui, editor, title: `MCP ${server.name}`, items: rows, onPick: (v) => {
          if (v === '__back') refresh();
          else if (v === '__reconnect') reconnect(server.name);
          else { rt.notice = color.dim(`tool: ${v}`); render(); }
        } });
      };
      openPicker({
        tui, editor, title: 'MCP servers', items,
        footer: 'enter detail · r reconnect · R reconnect failed · esc close',
        onPick: detail,
        onInput: (data, item) => {
          if (data === 'R') {
            rt.notice = color.dim('reconnecting disconnected/error MCP servers…'); render();
            runApplication(() => client.reconnectMcpAll(), () => { rt.notice = color.dim('MCP reconnect complete'); refresh(); render(); }, fail);
            return true;
          }
          if (data === 'r' && item) { reconnect(item.value); return true; }
          return false;
        },
      });
    }, fail);
  };

  const openSkillsModal = (): void => {
    runApplication(() => client.skills(), (skills) => {
      if (skills.length === 0) { rt.notice = color.dim('no skills found'); render(); return; }
      const refresh = () => openSkillsModal();
      // Push a skill into the CURRENT conversation with PI's native `/skill:name` command — the daemon's
      // prompt path expands it to the skill's full instructions (progressive disclosure keeps only
      // name+description in the system prompt). Nothing to load if the skills plugin is off.
      const loadSkill = (name: string, active: boolean): void => {
        if (!active) { rt.notice = color.dim('the skills plugin is disabled — enable it in Settings → Plugins first'); render(); return; }
        // onSubmit clears any notice and shows the sent turn itself, so a "loading…" notice here would be
        // wiped before it ever renders — just submit the /skill command.
        editor.onSubmit?.(`/skill:${name}`);
      };
      const confirmDelete = (name: string): void => {
        openPicker({
          tui, editor, title: `Delete skill "${name}"?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the skill' },
            { value: 'yes', label: 'Delete', description: 'user skill only' },
          ],
          onPick: (v) => {
            if (v !== 'yes') { refresh(); return; }
            runApplication(() => client.deleteSkill(name), () => { rt.notice = color.dim('skill deleted'); refresh(); render(); }, fail);
          },
        });
      };
      openPicker({
        tui, editor, title: 'Skills',
        items: skills.map((s) => ({ value: s.name, label: s.name, description: `${s.scope ?? s.source}${s.description ? ` · ${s.description}` : ''}` })),
        footer: 'type filter · enter detail · ctrl+l load · ctrl+d delete · esc close',
        onPick: (name) => {
          const s = skills.find((skill) => skill.name === name);
          if (!s) return;
          openPicker({
            tui, editor, title: `Skill ${s.name}`,
            items: [
              { value: '__back', label: 'Back', description: 'return to skills' },
              { value: '__load', label: 'Load into conversation', description: s.active ? 'agent reads it now and follows it' : 'enable the skills plugin first' },
              { value: '__delete', label: s.canDelete ? 'Delete' : 'Protected', description: s.canDelete ? 'delete this user-defined skill' : 'bundled/system skill cannot be deleted' },
              { value: '__location', label: 'Location', description: s.location ?? '' },
              { value: '__active', label: 'State', description: s.active ? 'active/loaded' : 'skills plugin disabled' },
            ],
            onPick: (v) => {
              if (v === '__back') refresh();
              else if (v === '__load') loadSkill(s.name, s.active === true);
              else if (v === '__delete' && s.canDelete) confirmDelete(s.name);
            },
          });
        },
        onInput: (data, item, close) => {
          if (!item) return false;
          const s = skills.find((skill) => skill.name === item.value);
          if (!s) return false;
          if (isCtrlL(data)) { close(); loadSkill(s.name, s.active === true); return true; }
          if (isCtrlD(data)) {
            if (!s.canDelete) { rt.notice = color.dim('bundled/system skills are protected'); render(); return true; }
            close();
            confirmDelete(s.name);
            return true;
          }
          return false;
        },
      });
    }, fail);
  };

  const taskStatusGlyph = (status: string): string => status === 'completed' ? color.success('[x]')
    : status === 'in_progress' ? color.warning('[•]') : color.faint('[ ]');

  /** Mirror a task mutation back into the pinned Todo card.
   *
   *  The todo plugin re-emits the card after every TOOL call, but its HTTP routes deliberately do not —
   *  they answer the caller and leave the panel to whoever asked. So a change made from `/tasks` or from a
   *  card row has to rebuild the card here, through the ONE mapper the plugin's own renderer mirrors. */
  const syncTodoCard = (next: SessionTaskView[]): void => {
    rt.cards = [...rt.cards.filter((item) => item.id !== TODO_CARD_ID), todoCard(next)];
  };

  const confirmDeleteTask = (taskId: string, subject: string): void => {
    openPicker({
      tui, editor, title: `Delete task "${subject}"?`,
      items: [
        { value: 'no', label: 'Cancel', description: 'keep the task' },
        { value: 'yes', label: 'Delete', description: 'also removes its dependency edges' },
      ],
      onPick: (value) => {
        if (value !== 'yes') { openTasksModal(); return; }
        runSession(() => client.deleteSessionTask(taskId), (next) => { syncTodoCard(next); rt.notice = color.dim('task deleted'); openTasksModal(); render(); }, fail);
      },
    });
  };

  /** The per-task action sheet, reached BOTH from the `/tasks` list and from a click on a Todo card row.
   *  It takes an id rather than an already-fetched task precisely so the card can open it without holding
   *  the list — and re-reading the tasks also means the sheet never acts on a stale snapshot. */
  const openTaskActions = (taskId: string): void => {
    runSession(() => client.sessionTasks(), (tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      // A card row outlives its task: the panel is a snapshot, and the agent may have deleted the task
      // between the frame that drew the row and the click on it.
      if (!task) { rt.notice = color.dim(`task #${taskId} no longer exists`); render(); return; }
      openPicker({
        tui, editor, title: `Task #${task.id}`,
        items: [
          { value: '__back', label: 'Back', description: task.description },
          { value: 'pending', label: '[ ] Pending', description: 'mark as waiting' },
          { value: 'in_progress', label: '[•] In progress', description: 'mark as active' },
          { value: 'completed', label: '[x] Completed', description: 'mark as finished' },
          { value: '__delete', label: 'Delete', description: 'permanently remove this task' },
        ],
        onPick: (value) => {
          if (value === '__back') openTasksModal();
          else if (value === '__delete') confirmDeleteTask(task.id, task.subject);
          else runSession(() => client.updateSessionTask(task.id, value as SessionTaskView['status']), (result) => { syncTodoCard(result.tasks); openTasksModal(); render(); }, fail);
        },
      });
    }, fail);
  };

  const openTasksModal = (): void => {
    runSession(() => client.sessionTasks(), (tasks) => {
      if (tasks.length === 0) { rt.notice = color.dim('no tasks in this conversation'); render(); return; }
      openPicker({
        tui, editor, title: 'Tasks',
        items: tasks.map((task) => ({ value: task.id, label: `${taskStatusGlyph(task.status)} ${task.subject}`, description: task.description })),
        footer: 'type filter · enter manage · esc close',
        onPick: (taskId) => openTaskActions(taskId),
      });
    }, fail);
  };

  // `/sandbox` — the terminal's chooser over the sandbox plugin's own routes. Every operation here IS one
  // of those routes: the plugin owns workspace creation, the conversation binding and the removal guards,
  // so this file only lists, asks and reports. In particular it never writes a binding or a working
  // directory of its own — `workspaces/use` is the single writer, and the daemon derives the turn's cwd
  // from what that route stored.
  const sandboxFail = (e: Error): void => { rt.notice = color.error(`error: ${sandboxReason(e) ?? e.message}`); render(); };

  const useSandboxWorkspace = (workspace: SandboxWorkspaceView): void => {
    const sessionId = client.boundSession;
    if (!sessionId) { rt.notice = color.error('no active conversation to bind a workspace to'); render(); return; }
    runSession(() => client.sandboxUseWorkspace({ workspaceId: workspace.id, sessionId, projectId: workspace.projectId }), (bound) => {
      // The route just wrote the binding the daemon reads to place the turn, so the path it answers with
      // IS the new working directory. Report it rather than asserting anything locally.
      rt.notice = color.success(`working directory: ${bound.path}`);
      render();
    }, sandboxFail);
  };

  // "Return to project": the inverse of a switch, and the only way to undo one without destroying
  // anything. The route deletes this conversation's binding rows and nothing else — the worktree, its
  // branch and its files all stay exactly where they are, and it can be switched back into afterwards.
  const releaseSandboxWorkspaces = (): void => {
    const sessionId = client.boundSession;
    if (!sessionId) { rt.notice = color.error('no active conversation to return to its project'); render(); return; }
    runSession(() => client.sandboxReleaseWorkspaces(sessionId), (result) => {
      rt.notice = result.released > 0
        ? color.success('this conversation works in its project directory again — the workspace is kept')
        : color.dim('this conversation already works in its project directory');
      openSandboxModal();
      render();
    }, (e) => {
      rt.notice = color.error(`still working in the workspace — ${sandboxReason(e) ?? e.message}`);
      render();
    });
  };

  const confirmDeleteSandboxWorkspace = (workspace: SandboxWorkspaceView): void => {
    runSession(() => client.sandboxRemovalPreview(workspace.id), (preview) => {
      const carried = [
        preview.dirty > 0 ? `${preview.dirty} changed` : null,
        preview.untracked > 0 ? `${preview.untracked} untracked` : null,
        preview.uniqueCommits > 0 ? `${preview.uniqueCommits} own commit${preview.uniqueCommits === 1 ? '' : 's'}` : null,
        preview.activeProcesses > 0 ? `${preview.activeProcesses} running` : null,
      ].filter(Boolean).join(' · ');
      openPicker({
        tui, editor, title: `Delete workspace "${workspace.label}"?`,
        items: [
          { value: 'no', label: 'Cancel', description: 'keep the workspace' },
          {
            value: 'yes',
            label: 'Delete',
            description: carried ? `refused while it holds ${carried}` : 'removes the worktree and its branch',
          },
        ],
        onPick: (value) => {
          if (value !== 'yes') { openSandboxModal(); return; }
          // The safe path, always: no discard and no force, so the plugin refuses rather than destroying
          // work, and a refusal leaves the worktree exactly as it was.
          runSession(() => client.sandboxRemoveWorkspace(workspace.id), () => {
            rt.notice = color.dim(`workspace ${workspace.label} removed`);
            openSandboxModal();
            render();
          }, (e) => {
            rt.notice = color.error(`workspace kept — ${sandboxReason(e) ?? e.message}`);
            render();
          });
        },
      });
    }, sandboxFail);
  };

  const openSandboxActions = (workspace: SandboxWorkspaceView, active: boolean): void => {
    openPicker({
      tui, editor, title: `Workspace ${workspace.label}`,
      items: [
        { value: '__back', label: 'Back', description: workspace.path },
        {
          value: '__use',
          label: 'Use in this conversation',
          description: active ? 'already the active workspace here' : `work in ${workspace.branch} from now on`,
        },
        { value: '__delete', label: 'Delete', description: 'clean workspaces only — never discards work' },
      ],
      onPick: (value) => {
        if (value === '__back') openSandboxModal();
        else if (value === '__use') useSandboxWorkspace(workspace);
        else confirmDeleteSandboxWorkspace(workspace);
      },
    });
  };

  const createSandboxWorkspace = (overview: SandboxOverview): void => {
    if (overview.projects.length === 0) { rt.notice = color.dim('no accessible projects to create a workspace in'); render(); return; }
    openPicker({
      tui, editor, title: 'New workspace · project',
      items: overview.projects.map((project) => ({ value: String(project.id), label: project.slug, description: project.path })),
      footer: 'enter pick · type filter · esc close',
      onPick: (picked) => {
        const project = overview.projects.find((entry) => String(entry.id) === picked);
        if (!project) return;
        openTextInput({
          tui, editor, title: `New workspace in ${project.slug} · name`,
          onSubmit: (rawLabel) => {
            const label = rawLabel.trim();
            if (!label) { rt.notice = color.dim('cancelled — a workspace name is required'); render(); return; }
            openTextInput({
              // The overview states the repository's REAL default branch, or null when it has none. A null
              // leaves the field empty and the ref is asked for — `main` here was a guess at a name that
              // need not exist in that repository at all.
              tui, editor,
              title: project.defaultRef
                ? `${label} · base ref`
                : `${label} · base ref (${project.slug} states no default branch)`,
              initial: project.defaultRef ?? '',
              onSubmit: (rawRef) => {
                const baseRef = rawRef.trim();
                if (!baseRef) { rt.notice = color.dim('cancelled — a base ref is required'); render(); return; }
                // Create makes the worktree and nothing else. Binding this conversation to it is the
                // separate, explicit `workspaces/use` step the web drawer also requires, so both surfaces
                // mean the same thing by "create" and neither moves the working directory silently.
                runSession(() => client.sandboxCreateWorkspace({ projectId: project.id, label, baseRef }), (workspace) => {
                  rt.notice = color.success(`workspace ${workspace.label} ready at ${workspace.path} — this conversation still works where it did; open the workspace and choose "Use in this conversation" to switch`);
                  openSandboxModal();
                  render();
                }, sandboxFail);
              },
            });
          },
        });
      },
    });
  };

  const openSandboxModal = (): void => {
    runSession(() => client.sandboxOverview(), (overview) => {
      const projectName = (id: number): string => overview.projects.find((project) => project.id === id)?.slug ?? `project ${id}`;
      const activeHere = (workspace: SandboxWorkspaceView): boolean =>
        !!client.boundSession && workspace.bindings.some((binding) => binding.sessionId === client.boundSession);
      openPicker({
        tui, editor, title: 'Sandbox workspaces',
        // Refreshing the list and returning to the project are commands ABOUT this modal, not workspaces
        // to open — as rows they read like two more worktrees to manage. They are keys instead, the way
        // /sessions and /skills already expose their non-row actions, and the footer names them. Creating
        // stays a row: it opens a flow of its own and belongs where the list of things one can end up
        // with is.
        items: [
          { value: '__create', label: '+ New workspace', description: 'create a Git worktree — this conversation stays where it is until you switch it' },
          ...overview.workspaces.map((workspace) => ({
            value: workspace.id,
            label: `${activeHere(workspace) ? '▸ ' : ''}${workspace.label}`,
            description: `${projectName(workspace.projectId)} · ${workspace.branch} · ${sandboxStateSummary(workspace)}`,
          })),
        ],
        footer: 'enter manage · type filter · ctrl+r refresh · ctrl+p return to project · esc close',
        onInput: (data, _selected, close) => {
          if (isCtrlR(data)) { close(); openSandboxModal(); return true; }
          if (isCtrlP(data)) {
            // Same guard the row carried: with nothing bound here there is nothing to return FROM, and
            // saying so beats a route call that can only answer "already there".
            if (!overview.workspaces.some(activeHere)) {
              rt.notice = color.dim('this conversation already works in its project directory');
              render();
              return true;
            }
            close();
            releaseSandboxWorkspaces();
            return true;
          }
          return false;
        },
        onPick: (value) => {
          if (value === '__create') { createSandboxWorkspace(overview); return; }
          const workspace = overview.workspaces.find((entry) => entry.id === value);
          if (workspace) openSandboxActions(workspace, activeHere(workspace));
        },
      });
    }, sandboxFail);
  };

  // /lsp as a status modal (mirrors /mcp): whether diagnostics are enabled and running, one row per
  // language server (● running · ○ installed · ✗ missing), and the on/off toggle as the first row —
  // replaces the old blind flip, so the operator SEES the state before (and after) changing it.
  const openLspModal = (): void => {
    runApplication(() => client.lspStatus(), (s) => {
      const refresh = () => openLspModal();
      const items = [
        {
          value: '__toggle',
          label: s.enabled ? 'Disable LSP diagnostics' : 'Enable LSP diagnostics',
          description: s.enabled ? 'stops every language server' : 'type-check edits live after each change',
        },
        ...s.servers.map((srv) => ({
          value: srv.command,
          label: `${srv.running ? color.success('●') : srv.installed ? color.faint('○') : color.error('✗')} ${srv.label}`,
          description: srv.running ? 'running · ctrl+u uninstalls' : srv.installed ? (srv.installable ? 'installed · ctrl+u uninstalls' : 'installed · starts on the first check')
            : srv.installable ? `not installed · ctrl+i installs (${srv.installHint})` : `not installed · ${srv.installHint}`,
        })),
      ];
      // ctrl+i installs / ctrl+u uninstalls the highlighted server daemon-side. In a terminal ctrl+i IS
      // Tab (\t) — same byte — so Tab doubles as the install key here.
      const runManage = (srv: { label: string; command: string }, install: boolean): void => {
        rt.notice = color.dim(install ? `installing ${srv.label} (npm, this can take a minute)…` : `uninstalling ${srv.label}…`);
        render();
        // Deliberately NO modal reopen when npm finishes: the user may be typing (or inside another
        // picker) minutes later — a surprise overlay would steal focus and strand the one beneath it.
        // The outcome lands as a notice; /lsp shows the fresh state on demand.
        runApplication(async () => {
          const message = await (install ? client.lspInstall(srv.command) : client.lspUninstall(srv.command));
          await refreshMeta();
          return message;
        }, (message) => { rt.notice = color.dim(`${message} · /lsp shows the current state`); render(); }, fail);
      };
      const manageKey = (data: string, selected: { value: string } | null, close: () => void): boolean => {
        const install = isTabKey(data);
        const uninstall = !install && isCtrlU(data);
        if (!install && !uninstall) return false;
        const srv = s.servers.find((x) => x.command === selected?.value);
        if (!srv || (install && srv.installed) || (uninstall && !srv.installed)) return true; // nothing to do
        if (!srv.installable) {
          rt.notice = color.dim(`${srv.label} ships with its toolchain — ${install ? 'install' : 'remove'} it with your package manager (${srv.installHint})`);
          render();
          return true;
        }
        close();
        if (install) { runManage(srv, true); return true; }
        // Uninstalling is destructive (and ctrl+u doubles as "clear line" muscle memory) → confirm first.
        openPicker({
          tui, editor, title: `Uninstall ${srv.label}?`,
          items: [
            { value: 'no', label: 'Cancel', description: 'keep the server' },
            { value: 'yes', label: 'Uninstall', description: "removes it from Elowen's prefix and stops running servers" },
          ],
          onPick: (v) => { if (v === 'yes') runManage(srv, false); },
        });
        return true;
      };
      openPicker({
        tui, editor,
        title: `LSP · ${s.enabled ? (s.running ? 'on · running' : 'on · idle') : 'off'}`,
        items,
        footer: 'enter toggle · ctrl+i install · ctrl+u uninstall · esc close',
        onInput: manageKey,
        onPick: (v) => {
          if (v !== '__toggle') { refresh(); return; }
          const on = !s.enabled;
          runApplication(async () => {
            // The flag is the lsp plugin's own config: saving it persists the choice AND hot-reloads
            // the plugin, whose service stops every language server on the way down.
            await client.setLspDiagnostics(on);
            // refreshMeta keeps the right-panel LSP Active/Inactive line in step with the flip.
            await refreshMeta();
          }, () => {
            rt.notice = color.dim(on
              ? 'LSP diagnostics ON — the agent can now type-check edits live.'
              : 'LSP diagnostics OFF — language servers stopped.');
            refresh();
            render();
          }, fail);
        },
      });
    }, fail);
  };

  const openToolsModal = (): void => {
    runApplication(() => client.tools(), (tools) => {
      if (tools.length === 0) { rt.notice = color.dim('no active plugin tools'); render(); return; }
      const refresh = () => openToolsModal();
      openPicker({
        tui, editor, title: 'Tools',
        items: tools.map((t) => ({ value: t.name, label: t.name, description: `${t.plugin}${t.schema ? ` · ${t.schema}` : ''}` })),
        onPick: (name) => {
          const t = tools.find((tool) => tool.name === name);
          if (!t) { rt.notice = color.dim(name); render(); return; }
          openPicker({
            tui, editor, title: `Tool ${t.name}`,
            items: [
              { value: '__back', label: 'Back', description: 'return to tools' },
              { value: '__plugin', label: 'Plugin', description: t.plugin },
              { value: '__schema', label: 'Schema', description: t.schema ?? 'no input schema' },
              { value: '__description', label: 'Description', description: t.description ?? 'no description' },
            ],
            onPick: (v) => { if (v === '__back') refresh(); },
          });
        },
      });
    }, fail);
  };

  // /keybinds as an interactive, live-applied editor: arrow-key list of every action, Enter captures the
  // next keypress as its new chord (press the leader first to compose a leader sequence), x unbinds, r
  // resets. Each change persists to cli-prefs.json AND swaps the running keymap via shell.reloadKeymap —
  // no restart. Hand-editing "keybinds" in cli-prefs.json still works (both write the same map).
  const openKeybindsModal = (): void => {
    openKeybindsEditor({ tui, editor, reload: shell.reloadKeymap });
  };

  // /statusline: tick what the bottom status bar shows. The toggles are the statusline plugin's own
  // config (shared with the web dock), so each change PATCHes it server-side and refreshMeta pulls the
  // fresh BrainStatus.statusline back into the live bar.
  const openStatuslineModal = (): void => {
    openStatuslineEditor({
      tui, editor,
      current: rt.lineCfg,
      save: (values, onError) => {
        runApplication(async () => {
          await client.setStatuslineConfig(values);
          await refreshMeta();
        }, () => { render(); }, (e) => { onError(); fail(e); });
      },
    });
  };

  return {
    openThinkingPicker, cycleThinkingLevel, openModelPicker, applyModelArg, changeDirectory, applyTheme, openThemePicker,
    openHelpModal, openStatsModal, openSessionsModal, openMcpModal, openSkillsModal, openTasksModal,
    openTaskActions, openSandboxModal, openLspModal, openToolsModal, openKeybindsModal, openStatuslineModal,
  };
}
