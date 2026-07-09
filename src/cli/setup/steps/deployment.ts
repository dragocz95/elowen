import * as p from '../../ui/prompts.js';
import { realRunner } from '../../install/runner.js';
import { readInstallInfo, serializeInstallInfo, INSTALL_INFO_PATH } from '../../installInfo.js';
import { chooseDeployment, provisionProxy, publicUrl, type DeployPorts } from '../../provision/deployment.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** Optional Deployment step — only present on a systemd-provisioned box run as root (gated by
 *  buildSteps/deploymentStepApplies). It reuses the SAME reverse-proxy question set + nginx/TLS executors
 *  as `elowen install`, so `elowen setup` can (re)point a domain and (re)issue a certificate without
 *  re-running the whole installer.
 *
 *  Scope: it reconfigures the reverse proxy + TLS for a domain deployment. Switching to IP/localhost also
 *  changes the web server's bind interface, which the systemd units own — that stays with `elowen install`. */
export async function runDeploymentStep(ctx: WizardCtx): Promise<StepResult> {
  const info = readInstallInfo();
  if (!info) return { status: 'skipped' }; // gated upstream; defensive — nothing to reconfigure without install.json

  p.log.info(`Current deployment: ${info.publicUrl}`);
  const go = guard(await p.confirm({ message: 'Reconfigure the reverse proxy / HTTPS for this box?', initialValue: false }));
  if (!go) return { status: 'skipped' };

  const r = realRunner();
  const ports: DeployPorts = { web: info.webPort, daemon: info.daemonPort };
  const deploy = await chooseDeployment(r, ports.web);
  if (!deploy) return { status: 'back' }; // cancelled the sub-prompts — back out to re-choose

  if (deploy.mode !== 'domain') {
    p.log.warn('Switching to IP/localhost also changes the web bind interface, which the systemd units own — re-run `elowen install` to change the deployment mode. Nothing was changed.');
    return { status: 'skipped' };
  }

  // provisionProxy's proxy phase (apt-get, nginx -t, systemctl reload) throws via must() on any failure —
  // e.g. an unrelated broken vhost failing `nginx -t`. Contain it so a failed reconfigure fails THIS step
  // gracefully (the wizard continues, the step can be retried) instead of crashing runOnboarding and
  // losing every earlier answer.
  let tls: boolean;
  try { ({ tls } = await provisionProxy(r, deploy, ports)); }
  catch (e) {
    p.log.error(`Reconfiguring the reverse proxy failed: ${(e as Error).message}`);
    return { status: 'skipped' };
  }
  const url = publicUrl(deploy, tls, ports.web);

  // Persist the new public URL/mode so the launcher menu + outro point at the right place.
  try { await r.writeFile(INSTALL_INFO_PATH, serializeInstallInfo({ ...info, publicUrl: url, mode: deploy.mode })); }
  catch (e) { p.log.warn(`Couldn't update ${INSTALL_INFO_PATH}: ${(e as Error).message}`); }

  ctx.answers.deployment = { mode: deploy.mode, url };
  p.log.success(`Deployment updated — ${url}`);
  return { status: 'done' };
}
