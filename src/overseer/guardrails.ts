const GUARDRAILS = ['schema', 'migration', 'auth', 'payments', 'destructive'] as const;

const PATTERNS: Record<string, RegExp> = {
  schema: /\bschema\b/i,
  migration: /\bmigrat/i,
  auth: /\b(auth|login|password|token)\b/i,
  payments: /\b(payment|billing|stripe|invoice)\b/i,
  destructive: /\b(delete|drop|truncate|rm -rf|destroy)\b/i,
};

export function detectGuardrails(text: string): string[] {
  return GUARDRAILS.filter(g => PATTERNS[g]!.test(text));
}

export function isCleared(triggered: string[], cleared: string[]): boolean {
  return triggered.every(g => cleared.includes(g));
}
