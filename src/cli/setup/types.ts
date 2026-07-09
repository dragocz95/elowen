import { isCancel } from '../ui/prompts.js';
import type { BrainProviderType } from '../../store/configStore.js';

/** How a step ended: configured, deliberately skipped, or the user asked to go back a step. */
type StepStatus = 'done' | 'skipped' | 'back';
export interface StepResult { status: StepStatus }

/** The accumulator every step reads/writes. `ai` is the hand-off the Memory step and the autopilot-
 *  wiring logic depend on (a reused key + an openai-type provider is what can back embeddings/relay). */
export interface WizardAnswers {
  account?: { username: string; created: boolean; signedIn: boolean };
  deployment?: { mode: string; url: string };
  project?: { slug: string; path: string; connected: boolean };
  ai?: { status: StepStatus; summary: string; providerId?: string; providerType?: BrainProviderType; model?: string; hasKey?: boolean };
  memory?: { status: StepStatus; summary: string };
  lsp?: { status: StepStatus; summary: string };
}

/** Shared context handed to every step. `token` is the admin bearer set once the Account step succeeds;
 *  `fetchFn` is injected so the API-facing logic stays unit-testable (mirrors setup.ts). */
export interface WizardCtx {
  base: string;
  fetchFn: typeof fetch;
  token?: string;
  answers: WizardAnswers;
  /** True when the wizard runs embedded inside `elowen install` (which already provisioned the box and,
   *  on a fresh install, will create the admin here). Steps use it to avoid re-asking install-owned
   *  questions or forcing a sign-in on a box install just set up. */
  embedded?: boolean;
}

export interface WizardStep {
  id: 'account' | 'deployment' | 'project' | 'ai' | 'memory' | 'lsp';
  /** Shown in the "[n/TOTAL] <title>" progress header. */
  title: string;
  run(ctx: WizardCtx): Promise<StepResult>;
}

/** Thrown when the user cancels a prompt (ctrl+c / esc). The orchestrator catches it to offer save-and-
 *  resume rather than crashing the wizard — recoverable, unlike the install wizard's `bail` exit. */
export class WizardCancelled extends Error {
  constructor() { super('wizard cancelled'); this.name = 'WizardCancelled'; }
}

/** Unwrap a prompt result, throwing WizardCancelled on cancel so step code reads top-to-bottom. */
export function guard<T>(value: T | symbol): T {
  if (isCancel(value)) throw new WizardCancelled();
  return value as T;
}
