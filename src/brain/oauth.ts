import { randomUUID } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import type { BrainCredentialAccess } from './providerUsage.js';

/** What the settings UI needs to drive a login: where to send the user, what to show, and whether we
 *  are waiting for a pasted code (Anthropic-style) or just polling (device-code style). */
export interface OAuthFlowState {
  id: string;
  provider: string;
  status: 'pending' | 'action-required' | 'success' | 'error';
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  /** True while the flow waits for user-submitted text (authorization code / prompt answer). */
  needsInput: boolean;
  error?: string;
}

interface Flow extends OAuthFlowState { resolveInput?: (value: string) => void }

/** Drives pi-ai OAuth logins (Anthropic / GitHub Copilot / OpenAI Codex) from the web UI: `start`
 *  kicks the provider's login in the background and the UI polls `get` + posts `submitInput` when the
 *  flow asks for a pasted code. Credentials land in the runtime's persistent store (auto-refresh handled
 *  by pi). One flow at a time per provider is plenty for an admin action. */
export class BrainOAuthManager {
  private flows = new Map<string, Flow>();
  constructor(private runtime: ModelRuntime, private creds: BrainCredentialAccess) {}

  /** Whether a credential exists for a built-in oauth provider id (e.g. 'anthropic'). */
  connected(provider: string): boolean {
    return !!this.creds.get(provider);
  }

  /** `method` picks a login sub-flow when the provider offers a choice — openai-codex exposes
   *  `browser` (loopback callback, needs a reachable localhost) and `device_code` (headless: show a
   *  code, poll for completion). CLI/remote callers pass `device_code` since the loopback is unreachable
   *  over SSH. Ignored by providers without a method select. */
  start(provider: string, opts: { method?: string } = {}): OAuthFlowState {
    const flow: Flow = { id: randomUUID(), provider, status: 'pending', needsInput: false };
    // Prune settled flows so the map stays bounded (admin-only, but no reason to leak entries).
    for (const [id, f] of this.flows) {
      if (f.status === 'success' || f.status === 'error') this.flows.delete(id);
    }
    this.flows.set(flow.id, flow);
    const waitForInput = (signal?: AbortSignal): Promise<string> => new Promise<string>((resolve) => {
      if (signal?.aborted) { resolve(''); return; }
      flow.needsInput = true;
      flow.status = 'action-required';
      const settle = (v: string) => { flow.needsInput = false; flow.resolveInput = undefined; resolve(v); };
      flow.resolveInput = settle;
      // An out-of-band completion (the openai-codex loopback callback winning the race) aborts the pending
      // prompt — clear the waiting state so a login that already resolved doesn't keep reporting needsInput.
      signal?.addEventListener('abort', () => settle(''), { once: true });
    });
    // PI 0.80.8 unified the login callbacks into one `AuthInteraction`: `notify` streams status events
    // (the browser URL / device code), `prompt` asks for a value (a select option or the pasted code).
    const interaction: AuthInteraction = {
      notify: (event) => {
        if (event.type === 'auth_url') { flow.authUrl = event.url; flow.instructions = event.instructions; flow.status = 'action-required'; }
        else if (event.type === 'device_code') { flow.authUrl = event.verificationUri; flow.userCode = event.userCode; flow.status = 'action-required'; }
        // 'info' / 'progress' carry status text only — nothing the picker renders.
      },
      prompt: (prompt) => {
        // A method select (openai-codex browser vs device_code): honour the caller's choice, else the first.
        if (prompt.type === 'select') {
          const chosen = (opts.method ? prompt.options.find((o) => o.id === opts.method)?.id : undefined) ?? prompt.options[0]?.id;
          return Promise.resolve(chosen ?? '');
        }
        // `manual_code` is the pasted authorization code (Anthropic/Codex) — surface it and wait for the UI.
        if (prompt.type === 'manual_code') return waitForInput(prompt.signal);
        // `text`/`secret`: among the supported providers the only such prompt is GitHub Copilot's OPTIONAL
        // enterprise-domain field, emitted BEFORE its device code. The old callbacks auto-answered an
        // empty-allowed prompt (`allowEmpty ? '' : wait`); the unified API dropped that flag, so blocking
        // here would strand the Copilot flow on a contextless input the code-submit endpoint then rejects
        // (it 400s an empty value). Auto-answer empty to let the flow reach the device code, as before.
        return Promise.resolve('');
      },
    };
    void this.runtime.login(provider, 'oauth', interaction).then(
      () => { flow.status = 'success'; },
      (e: unknown) => { flow.status = 'error'; flow.error = e instanceof Error ? e.message : String(e); },
    );
    return this.snapshot(flow);
  }

  get(flowId: string): OAuthFlowState | undefined {
    const f = this.flows.get(flowId);
    return f && this.snapshot(f);
  }

  /** Feed the waiting flow the user's pasted code / prompt answer. False when nothing is waiting. */
  submitInput(flowId: string, value: string): boolean {
    const f = this.flows.get(flowId);
    if (!f?.resolveInput) return false;
    f.resolveInput(value);
    return true;
  }

  /** Drop a stored credential (disconnect the account). */
  async disconnect(provider: string): Promise<void> {
    await this.runtime.logout(provider);
  }

  private snapshot(f: Flow): OAuthFlowState {
    const { resolveInput, ...state } = f;
    return { ...state };
  }
}
