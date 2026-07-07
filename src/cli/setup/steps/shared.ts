import type { BrainProviderType } from '../../../store/configStore.js';
import { orcaExec } from '../../../shared/execs.js';
import { apiJson } from '../http.js';
import type { WizardCtx } from '../types.js';

/** A brain provider from the public config view — secrets masked to `apiKeySet`. */
export interface PublicProvider { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[]; apiKeySet: boolean }

/** Read the configured brain providers (public view). */
export async function getBrainProviders(ctx: WizardCtx): Promise<PublicProvider[]> {
  const r = await apiJson<{ brain?: { providers?: PublicProvider[] } }>(ctx, 'GET', '/config');
  return r.data?.brain?.providers ?? [];
}

/** Re-send shape for an existing provider when replacing the whole list: NO apiKey, so the config store
 *  keeps its stored key (never echoing or dropping a secret). */
export function keepProvider(e: PublicProvider): { id: string; label: string; type: BrainProviderType; baseUrl: string; models: string[] } {
  return { id: e.id, label: e.label, type: e.type, baseUrl: e.baseUrl, models: e.models };
}

/** Point the default task executor at the embedded (in-process) engine on a provider. PUTs ONLY the
 *  `exec` field — the config store merges `defaults` per-field, so re-reading and re-sending the whole
 *  block (as this used to) was both wasted work and a check-then-act race that could revert a concurrent
 *  edit of autonomy/maxSessions. Single source for the wizard AND headless setup. Returns whether it saved. */
export async function putEmbeddedExec(ctx: WizardCtx, providerId: string, model: string): Promise<boolean> {
  const r = await apiJson(ctx, 'PUT', '/config', { defaults: { exec: orcaExec(providerId, model) } });
  return r.ok;
}

/** A stack-free, human message for a failed API call or thrown error. Maps common statuses; otherwise
 *  falls back to the error's own message. Full stacks are shown only when the wizard runs with --debug. */
export function humanError(e: unknown, status?: number): string {
  if (status === 401 || status === 403) return 'You need to be signed in as an admin for this step.';
  if (status === 409) return 'That name is already taken.';
  const msg = e instanceof Error ? e.message : String(e ?? 'Unknown error');
  if (/ECONNREFUSED|fetch failed|network|ENOTFOUND/i.test(msg)) return "Couldn't reach the Orca daemon — is it running? Try `orca up`.";
  return msg;
}
