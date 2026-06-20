import { parseAnsi } from './ansi';

export type ActivityCategory = 'editing' | 'testing' | 'building' | 'installing' | 'thinking' | 'prompted' | 'error' | 'unknown';

interface Rule { re: RegExp; cat: ActivityCategory }

// Ordered — the first match wins. Each pattern matches against the plain-text
// tail (ANSI stripped, lowercased). Patterns are deliberately lightweight regex
// over the last few lines, not a full shell parser.
const RULES: Rule[] = [
  // Errors first so they take precedence over e.g. a build line that mentions "error".
  { re: /\b(failed|failure|panic|traceback|uncaught|cannot find module|command not found|enoent)\b/, cat: 'error' },
  // Waiting for human input — a permission / approval prompt or an interactive question.
  { re: /\b(do you want to|allow|approve|yes\/no|y\/n|press enter|press \[?enter\]? to continue)\b/, cat: 'prompted' },
  // Package installs / dependency work.
  { re: /\b(npm (install|ci|i|add)|yarn add|pnpm (add|install)|pip install|cargo (add|install)|apt[- ]get install|brew install)\b/, cat: 'installing' },
  // Running tests.
  { re: /\b(vitest|jest|pytest|cargo test|go test|npm (run )?test|mocha|playwright|✓|✗|[0-9]+ passing|[0-9]+ failing)\b/, cat: 'testing' },
  // Compiling / building.
  { re: /\b(npm run build|next build|tsc|cargo build|make\b|go build|webpack|vite build|compil|building)\b/, cat: 'building' },
  // Editing files — a patch apply, a write, or a tool editing a path.
  { re: /\b(edit|patch|wrote|updated?|created|apply|insert|delete|refactor|\.tsx?|\.jsx?|\.py|\.go|\.rs)\b/, cat: 'editing' },
  // The agent is reasoning, not touching files.
  { re: /\b(thinking|reasoning|analyz|planning|consider|let me|i'll|i will|let's)\b/, cat: 'thinking' },
];

/** Strip ANSI and lower-case the tail text. */
function plainText(tail: string): string {
  const text = tail.split('\n').map((l) => parseAnsi(l).map((s) => s.text).join('')).join('\n').toLowerCase();
  return text;
}

/** Derive a one-word activity category from the live tmux tail. Pure function — unit-testable. */
export function sessionActivity(tail: string): ActivityCategory {
  if (!tail || !tail.trim()) return 'unknown';
  const text = plainText(tail);
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.cat;
  }
  return 'unknown';
}