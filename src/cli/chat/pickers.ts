import { chatThemeItems, color, isChatThemeName, setChatTheme, setCustomChatTheme } from './theme.js';
import { savePrefs } from './prefs.js';
import { sessionItems, modelItems, parseModelValue, openPicker, openTextInput, openInfoModal } from './picker.js';
import { isCtrlD, isCtrlL, isCtrlP, isCtrlR, isCtrlU, isTabKey } from './keys.js';
import { openKeybindsEditor } from './keybindsEditor.js';
import { API_KEY_PROVIDERS } from '../setup/constants.js';
import { formatK } from '../ui/text.js';
import type { BrainProviderView } from './brainClient.js';
import type { ChatState } from './chatState.js';
import type { ChatApplicationActions, ChatApplicationResources, ChatTaskScope } from './chatCapabilities.js';
import type { StreamCoordinatorPort } from './streamCoordinator.js';

export interface Pickers {
  openThinkingPicker(): void;
  cycleThinkingLevel(): void;
  openModelPicker(): void;
  applyTheme(name: string): boolean;
  openThemePicker(): void;
  openHelpModal(): void;
  openStatusModal(): void;
  openSessionsModal(): void;
  openMcpModal(): void;
  openSkillsModal(): void;
  openLspModal(): void;
  openToolsModal(): void;
  openKeybindsModal(): void;
}

/** Everything the picker/modal surface of the chat offers: model + provider management, reasoning
 *  effort, themes, and the /sessions /mcp /skills /lsp /tools /status /help modals. */
export function createPickers(
  rt: ChatState,
  resources: Pick<ChatApplicationResources, 'client' | 'tui' | 'editor' | 'termSettings' | 'cwdLabel' | 'branchLabel' | 'commandDefs' | 'lifetime'>,
  actions: Pick<ChatApplicationActions, 'render' | 'refreshMeta'>,
  stream: StreamCoordinatorPort,
  shell: {
    /** Re-open the telemetry panel so a theme switch recolors it, keeping its hidden state. */
    reshowPanel(): void;
    /** Live-apply a /keybinds rebind to the running session (no restart). */
    reloadKeymap(): void;
  },
): Pickers {
  const { client, tui, editor, termSettings, cwdLabel, branchLabel, commandDefs, lifetime } = resources;
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
                      const baseUrl = url.trim().replace(/\/$/, '');
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

  const openModelPicker = (): void => {
    runApplication(() => client.models(), (models) => {
      if (models.length === 0) { rt.notice = color.dim('no models configured — ctrl+p in /model adds a provider'); render(); return; }
      const paid = models.filter((m) => !m.free);
      const free = models.filter((m) => m.free);
      const items = [
        ...modelItems(paid, rt.modelName),
        // OpenRouter's zero-cost catalog folds in at the bottom under a FREE header row.
        ...(free.length ? [{ value: '__free', label: color.faint('─ FREE · OpenRouter ─'), description: `${free.length} zero-cost models` }] : []),
        ...free.map((m) => ({ value: `${m.provider} ${m.model}`, label: `☆ ${m.model.replace(/:free$/, '')}`, description: `${m.providerLabel} · free` })),
      ];
      openPicker({
        tui, editor, title: 'Switch model', items,
        footer: 'enter switch · type to search · ctrl+p providers · esc close',
        onInput: (data, _selected, close) => {
          if (isCtrlP(data)) { close(); openProviderModal(); return true; }
          return false;
        },
        onPick: (value) => {
          if (value === '__free') { openModelPicker(); return; }
          rt.notice = color.dim('switching model…');
          render();
          runSession(() => client.setModel(parseModelValue(value)), (r) => {
            rt.modelName = r.model;
            // The server rebuilt the session — the old event stream is dead, reopen it.
            rt.streamAc.abort();
            const ac = new AbortController();
            rt.streamAc = ac;
            stream.openStream(ac);
            runSession(() => refreshMeta(), () => { rt.notice = ''; render(); }, fail);
          }, fail);
        },
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

  // /status as a read-only modal: model, reasoning, context/usage, project and any active goal at a glance.
  const openStatusModal = (): void => {
    runSession(() => Promise.all([client.status().catch(() => null), client.goal().catch(() => null)]), ([s, g]) => {
      const lines: string[] = [];
      const kv = (k: string, v: string): void => { lines.push(`${color.faint(k.padEnd(12))} ${color.text(v)}`); };
      if (s?.title) kv('conversation', s.title);
      kv('model', s?.model || '—');
      if (s?.thinkingLevel) kv('reasoning', s.thinkingLevelLabels?.[s.thinkingLevel] ?? s.thinkingLevel);
      if (s?.fastAvailable) kv('fast', s.fast ? 'on' : 'off');
      kv('mode', rt.workMode === 'plan' ? 'Plan' : 'Build');
      const u = s?.usage;
      if (u) {
        if (u.percent != null) kv('context', `${Math.round(u.percent)}%  (${formatK(u.tokens ?? 0)} / ${formatK(u.contextWindow)})`);
        kv('tokens', `${formatK(u.totalTokens)} total`);
        kv('cost', `$${u.cost.toFixed(2)}`);
      }
      kv('cwd', cwdLabel);
      if (branchLabel) kv('branch', branchLabel);
      if (g) {
        lines.push('');
        lines.push(color.accent('Goal'));
        kv('  status', g.status);
        kv('  turns', `${g.turns_used}/${g.turn_budget}`);
        if (g.paused_reason) kv('  paused', g.paused_reason);
      }
      openInfoModal({ tui, editor, title: 'Session status', lines });
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
          runApplication(async () => {
            const result = await client.command('lsp');
            // refreshMeta keeps the right-panel LSP Active/Inactive line in step with the flip.
            await refreshMeta();
            return result;
          }, (r) => { rt.notice = color.dim(r?.message ?? 'toggled LSP'); refresh(); render(); }, fail);
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

  return {
    openThinkingPicker, cycleThinkingLevel, openModelPicker, applyTheme, openThemePicker,
    openHelpModal, openStatusModal, openSessionsModal, openMcpModal, openSkillsModal,
    openLspModal, openToolsModal, openKeybindsModal,
  };
}
