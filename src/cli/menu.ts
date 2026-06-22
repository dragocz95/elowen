import { spawn } from 'node:child_process';
import * as p from '@clack/prompts';
import { status } from './launcher.js';
import { defaultLifecycleDeps, formatStatus, runLifecycle } from './commands.js';
import { isFirstRun, buildSetupPlan, applySetup, type SetupAnswers } from './setup.js';

const BASE = process.env.ORCA_URL ?? 'http://localhost:4400';

/** Open a URL in the user's default browser, cross-platform, fire-and-forget. */
function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* headless box — ignore */ }
}

const PROVIDERS: Record<string, string> = {
  OpenAI: 'https://api.openai.com/v1',
  Anthropic: 'https://api.anthropic.com/v1',
};

/** First-run wizard: collect admin creds + LLM provider/key/model, then persist via the daemon API. */
async function runWizard(): Promise<void> {
  p.log.step('First-run setup');
  const username = await p.text({ message: 'Admin username', initialValue: 'admin' });
  if (p.isCancel(username)) return;
  const password = await p.password({ message: 'Admin password', validate: (v) => ((v ?? '').length < 4 ? 'At least 4 characters' : undefined) });
  if (p.isCancel(password)) return;

  const choice = await p.select({
    message: 'LLM provider',
    options: [...Object.keys(PROVIDERS).map((k) => ({ value: k, label: k })), { value: 'Custom', label: 'Custom (enter URL)' }],
  });
  if (p.isCancel(choice)) return;
  let apiUrl = PROVIDERS[choice as string] ?? '';
  if (choice === 'Custom') {
    const custom = await p.text({ message: 'API base URL', placeholder: 'https://…/v1' });
    if (p.isCancel(custom)) return;
    apiUrl = custom;
  }
  const apiKey = await p.password({ message: 'API key (leave blank to set later in the web UI)' });
  if (p.isCancel(apiKey)) return;
  const model = await p.text({ message: 'Default model', initialValue: 'gpt-4o-mini' });
  if (p.isCancel(model)) return;

  const answers: SetupAnswers = { username, password, apiUrl, apiKey, model };
  const s = p.spinner();
  s.start('Saving…');
  try {
    await applySetup(fetch, BASE, buildSetupPlan(answers));
    s.stop('Setup complete — sign in at http://localhost:4500');
  } catch (e) {
    s.stop(`Setup failed: ${(e as Error).message}`);
  }
}

/** The interactive launcher menu shown when `orca` is run with no arguments in a terminal. */
export async function menu(env: NodeJS.ProcessEnv, version: string): Promise<void> {
  const deps = defaultLifecycleDeps(version);
  p.intro(`🐋 orcasynth v${version}`);

  for (;;) {
    const st = await status(env);
    const running = st.daemon.running;
    const action = await p.select({
      message: 'What do you want to do?',
      options: [
        running
          ? { value: 'down', label: 'Stop orca', hint: 'daemon + web' }
          : { value: 'up', label: 'Start orca', hint: 'daemon + web' },
        { value: 'status', label: 'Status' },
        { value: 'open', label: 'Open web UI', hint: 'http://localhost:4500' },
        { value: 'update', label: 'Update', hint: 'check npm for a newer version' },
        { value: 'exit', label: 'Exit' },
      ],
    });
    if (p.isCancel(action) || action === 'exit') break;

    if (action === 'status') { p.note(formatStatus(st), 'Status'); continue; }
    if (action === 'open') {
      if (!running) { await runLifecycle('up', env, deps); }
      openUrl('http://localhost:4500');
      p.log.success('Opening http://localhost:4500');
      continue;
    }
    if (action === 'up') {
      await runLifecycle('up', env, deps);
      // A brand-new install has no admin yet — offer the wizard right after the daemon is up.
      try { if (await isFirstRun(fetch, BASE)) await runWizard(); } catch { /* daemon slow — skip, user can rerun */ }
      continue;
    }
    await runLifecycle(action, env, deps); // 'down' | 'update'
  }

  p.outro('See you 🐋');
}
