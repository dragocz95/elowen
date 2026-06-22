import * as p from '@clack/prompts';
import { createAdmin, saveConfig, fetchAvailableClis, defaultExecForCli } from './setup.js';

const PROVIDERS: Record<string, string> = {
  OpenAI: 'https://api.openai.com/v1',
  Anthropic: 'https://api.anthropic.com/v1',
};

const CLI_LABEL: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' };

type AutopilotPatch = { model?: string; apiUrl?: string; apiKey?: string; pilotExec?: string; overseerExec?: string };

/** Configure the hosted-API (relay) autopilot engine: provider URL + key + default model. */
async function chooseApiEngine(): Promise<AutopilotPatch | null> {
  const choice = await p.select({
    message: 'LLM provider',
    options: [...Object.keys(PROVIDERS).map((k) => ({ value: k, label: k })), { value: 'Custom', label: 'Custom (enter URL)' }],
  });
  if (p.isCancel(choice)) return null;
  let apiUrl = PROVIDERS[choice as string] ?? '';
  if (choice === 'Custom') {
    const custom = await p.text({ message: 'API base URL', placeholder: 'https://…/v1' });
    if (p.isCancel(custom)) return null;
    apiUrl = custom;
  }
  const apiKey = await p.password({ message: 'API key (leave blank to set later in the web UI)' });
  if (p.isCancel(apiKey)) return null;
  const model = await p.text({ message: 'Default model', initialValue: 'gpt-4o-mini' });
  if (p.isCancel(model)) return null;
  const patch: AutopilotPatch = { model, apiUrl };
  if (apiKey) patch.apiKey = apiKey;
  return patch;
}

/** Pick the autopilot engine: an installed agent CLI (no API key — recommended) or a hosted API key.
 *  `clis` are the agent CLIs the daemon found installed for the service user, in recommended order. */
async function chooseAutopilot(clis: string[]): Promise<AutopilotPatch | null> {
  const options = [
    ...clis.map((c, i) => ({ value: `cli:${c}`, label: `${CLI_LABEL[c] ?? c} CLI`, hint: i === 0 ? 'no API key — recommended' : 'no API key' })),
    { value: 'apikey', label: 'LLM API key', hint: clis.length ? 'use a hosted model via an API key' : 'recommended' },
    { value: 'skip', label: 'Skip for now', hint: 'configure later in the web UI' },
  ];
  const choice = await p.select({ message: 'How should Autopilot plan and oversee missions?', options });
  if (p.isCancel(choice) || choice === 'skip') return null;
  if (choice === 'apikey') return chooseApiEngine();

  const cli = (choice as string).slice('cli:'.length);
  // opencode is provider-agnostic — ask which model it should use (it must already be authenticated).
  let opencodeModel: string | undefined;
  if (cli === 'opencode') {
    const m = await p.text({ message: 'OpenCode model for autopilot', placeholder: 'provider/model', initialValue: 'anthropic/claude-sonnet-4-5' });
    if (p.isCancel(m)) return null;
    opencodeModel = (m as string).trim() || undefined;
  }
  const exec = defaultExecForCli(cli, opencodeModel);
  return { pilotExec: exec, overseerExec: exec };
}

/** Interactive first-run wizard: create the admin, then let the operator pick the autopilot engine —
 *  an installed agent CLI (no API key) or an LLM API key — and persist it through the daemon API at
 *  `base`. The admin is created up front so the CLI-detection probe can authenticate (which engines
 *  are available is only knowable as the service user). Shared by the launcher menu and `orca
 *  install`. Returns the admin credentials on success (so the caller can run a login smoke test), or
 *  null if the operator cancelled before any account was created. Throws only on an API failure. */
export async function runSetupWizard(base: string): Promise<{ username: string; password: string } | null> {
  const username = await p.text({ message: 'Admin username', initialValue: 'admin' });
  if (p.isCancel(username)) return null;
  const password = await p.password({ message: 'Admin password', validate: (v) => ((v ?? '').length < 4 ? 'At least 4 characters' : undefined) });
  if (p.isCancel(password)) return null;

  const s = p.spinner();
  s.start('Creating admin…');
  let token: string;
  try {
    token = await createAdmin(fetch, base, { username, password });
    s.stop('Admin account created.');
  } catch (e) {
    s.stop(`Setup failed: ${(e as Error).message}`);
    throw e;
  }

  const clis = await fetchAvailableClis(fetch, base, token);
  const autopilot = await chooseAutopilot(clis);
  if (autopilot) {
    const s2 = p.spinner();
    s2.start('Saving autopilot settings…');
    try {
      await saveConfig(fetch, base, token, { autopilot });
      s2.stop(autopilot.pilotExec ? 'Autopilot will run through your agent CLI — no API key needed.' : 'Autopilot configured.');
    } catch (e) {
      // The admin already exists and is usable; autopilot can be configured later in the web UI.
      s2.stop(`Saving autopilot settings failed: ${(e as Error).message}`);
    }
  }
  return { username, password };
}
