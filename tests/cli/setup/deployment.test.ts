import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The deployment step drives the prompt adapter (confirm) and the reverse-proxy provisioner. Stub both so
// the recoverable-failure path is scriptable: p.confirm agrees to reconfigure, and provisionProxy can be
// made to throw the way its must()-based apt/nginx phase does on a broken box.
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  confirm: vi.fn(),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  isCancel: () => false,
}));
vi.mock('../../../src/cli/install/runner.js', () => ({ realRunner: () => ({ writeFile: vi.fn() }) }));
vi.mock('../../../src/cli/installInfo.js', () => ({
  readInstallInfo: () => ({ publicUrl: 'https://old.example', webPort: 4500, daemonPort: 4400, mode: 'domain' }),
  serializeInstallInfo: (x: unknown) => JSON.stringify(x),
  INSTALL_INFO_PATH: '/tmp/does-not-matter/install.json',
}));
vi.mock('../../../src/cli/provision/deployment.js', () => ({
  chooseDeployment: vi.fn(),
  provisionProxy: vi.fn(),
  publicUrl: () => 'https://new.example',
}));

async function mods(): Promise<{ confirm: Mock; chooseDeployment: Mock; provisionProxy: Mock; run: typeof import('../../../src/cli/setup/steps/deployment.js').runDeploymentStep }> {
  const prompts = await import('../../../src/cli/ui/prompts.js');
  const provision = await import('../../../src/cli/provision/deployment.js');
  const { runDeploymentStep } = await import('../../../src/cli/setup/steps/deployment.js');
  return {
    confirm: prompts.confirm as unknown as Mock,
    chooseDeployment: provision.chooseDeployment as unknown as Mock,
    provisionProxy: provision.provisionProxy as unknown as Mock,
    run: runDeploymentStep,
  };
}

const ctx = (): WizardCtx => ({ base: 'http://x', fetchFn: fetch, answers: {} });

describe('cli/setup deployment step — recoverable provisioning failure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a thrown provisionProxy (e.g. `nginx -t` fails) fails the STEP gracefully, not the wizard', async () => {
    const { confirm, chooseDeployment, provisionProxy, run } = await mods();
    confirm.mockResolvedValueOnce(true); // yes, reconfigure the reverse proxy
    chooseDeployment.mockResolvedValueOnce({ mode: 'domain', domain: 'build.example', email: 'a@b.c' });
    provisionProxy.mockRejectedValueOnce(new Error('nginx -t failed: broken vhost')); // must() blows up

    const c = ctx();
    // The whole point: this resolves to a skipped step instead of rejecting up into runOnboarding.
    await expect(run(c)).resolves.toEqual({ status: 'skipped' });
    expect(c.answers.deployment).toBeUndefined(); // nothing persisted from a failed reconfigure
  });

  it('a successful reconfigure still reports done with the new url', async () => {
    const { confirm, chooseDeployment, provisionProxy, run } = await mods();
    confirm.mockResolvedValueOnce(true);
    chooseDeployment.mockResolvedValueOnce({ mode: 'domain', domain: 'build.example', email: 'a@b.c' });
    provisionProxy.mockResolvedValueOnce({ tls: true });

    const c = ctx();
    expect(await run(c)).toEqual({ status: 'done' });
    expect(c.answers.deployment).toEqual({ mode: 'domain', url: 'https://new.example' });
  });
});
