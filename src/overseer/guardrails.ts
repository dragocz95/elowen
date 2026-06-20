const GUARDRAILS = ['schema', 'migration', 'auth', 'payments', 'destructive'] as const;
type Guardrail = typeof GUARDRAILS[number];

// Keyed by Guardrail so TypeScript enforces a pattern for every category — add one to GUARDRAILS
// without a pattern and this fails to compile, instead of throwing at runtime on a missing key.
const PATTERNS: Record<Guardrail, RegExp> = {
  schema: /\bschema\b/i,
  migration: /\bmigrat/i,
  auth: /\b(auth|login|password|token)\b/i,
  payments: /\b(payment|billing|stripe|invoice)\b/i,
  destructive: /\b(delete|drop|truncate|rm -rf|destroy)\b/i,
};

export function detectGuardrails(text: string): string[] {
  return GUARDRAILS.filter(g => PATTERNS[g].test(text));
}

export function isCleared(triggered: string[], cleared: string[]): boolean {
  const clearedSet = new Set(cleared);
  return triggered.every(g => clearedSet.has(g));
}
