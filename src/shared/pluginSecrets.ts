export interface PluginSecretValue {
  value: string;
  version: number;
}

/** A plugin-scoped secret namespace. The bag is already bound to one plugin and either the instance or
 * current account, so callers cannot name another owner at the trust boundary. */
export interface PluginSecretBag {
  get(key: string): PluginSecretValue | null;
  has(key: string): boolean;
  set(key: string, value: string, expectedVersion?: number): number;
  delete(key: string): boolean;
}
