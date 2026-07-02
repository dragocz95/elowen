import { randomUUID } from 'node:crypto';
import type { AuthStorage } from '@earendil-works/pi-coding-agent';

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
 *  flow asks for a pasted code. Credentials land in the brain's persistent AuthStorage (auto-refresh
 *  handled by pi). One flow at a time per provider is plenty for an admin action. */
export class BrainOAuthManager {
  private flows = new Map<string, Flow>();
  constructor(private auth: AuthStorage) {}

  /** Whether a credential exists for a built-in oauth provider id (e.g. 'anthropic'). */
  connected(provider: string): boolean {
    return !!this.auth.get(provider);
  }

  start(provider: string): OAuthFlowState {
    const flow: Flow = { id: randomUUID(), provider, status: 'pending', needsInput: false };
    // Prune settled flows so the map stays bounded (admin-only, but no reason to leak entries).
    for (const [id, f] of this.flows) {
      if (f.status === 'success' || f.status === 'error') this.flows.delete(id);
    }
    this.flows.set(flow.id, flow);
    const waitForInput = (): Promise<string> => new Promise<string>((resolve) => {
      flow.needsInput = true;
      flow.status = 'action-required';
      flow.resolveInput = (v) => { flow.needsInput = false; flow.resolveInput = undefined; resolve(v); };
    });
    void this.auth.login(provider, {
      onAuth: (info) => { flow.authUrl = info.url; flow.instructions = info.instructions; flow.status = 'action-required'; },
      onDeviceCode: (info) => { flow.authUrl = info.verificationUri; flow.userCode = info.userCode; flow.status = 'action-required'; },
      // Empty-allowed prompts (e.g. an enterprise domain) auto-answer with the default; anything
      // required (the pasted authorization code) waits for the UI.
      onPrompt: (prompt) => (prompt.allowEmpty ? Promise.resolve('') : waitForInput()),
      onManualCodeInput: () => waitForInput(),
      onSelect: async (prompt) => prompt.options[0]?.id, // no branching flows in our providers today
    }).then(
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
  disconnect(provider: string): void {
    this.auth.remove(provider);
  }

  private snapshot(f: Flow): OAuthFlowState {
    const { resolveInput, ...state } = f;
    return { ...state };
  }
}
