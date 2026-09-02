export interface InferenceClient {
  /** The model id this client decides with — recorded into audits so a mutation names the model behind it. */
  readonly model: string;
  /** `signal` lets a caller that a USER is waiting on impose its own, shorter deadline. Every
   *  implementation already carries a hard internal timeout sized for BACKGROUND work (a curator pass, a
   *  digest), which is minutes — far too long for anything rendered behind a spinner. The caller's signal
   *  narrows that ceiling; it never widens it. Omitted → the implementation's own timeout alone. */
  decide(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ text: string }>;
}
export interface RelayConfig { baseUrl: string; apiKey: string; model: string }
