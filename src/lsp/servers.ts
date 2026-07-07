/** Language detection + the registry of language servers Orca knows how to drive. Each entry maps a
 *  language id to the command that starts its server over stdio. The command is only spawned if it's
 *  actually on PATH (checked at spawn time), so an entry for a server the box doesn't have is a graceful
 *  no-op rather than an error — "LSP for all languages" degrades to "for every language whose server is
 *  installed". Pure data + helpers, so extension→language and language→server are unit-testable. */

export interface LanguageServerSpec {
  /** LSP language id sent in `textDocument/didOpen` (e.g. 'typescript', 'python'). */
  language: string;
  /** argv[0] — the server binary looked up on PATH. */
  command: string;
  /** Remaining argv (usually the stdio flag). */
  args: string[];
  /** Human label for menus/logs. */
  label: string;
}

/** File extension → LSP language id. Kept broad; an unmapped extension yields null (LSP skipped). */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  lua: 'lua',
  json: 'json', jsonc: 'jsonc',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', vue: 'vue',
  yaml: 'yaml', yml: 'yaml',
  sh: 'shellscript', bash: 'shellscript',
};

/** language id → the server that handles it. One server can cover several language ids (tsserver handles
 *  js/ts/jsx/tsx). The command is resolved on PATH at spawn time; missing → that language is skipped. */
const SERVERS: LanguageServerSpec[] = [
  { language: 'typescript', command: 'typescript-language-server', args: ['--stdio'], label: 'TypeScript' },
  { language: 'python', command: 'pyright-langserver', args: ['--stdio'], label: 'Pyright' },
  { language: 'go', command: 'gopls', args: [], label: 'gopls' },
  { language: 'rust', command: 'rust-analyzer', args: [], label: 'rust-analyzer' },
  { language: 'ruby', command: 'solargraph', args: ['stdio'], label: 'Solargraph' },
  { language: 'php', command: 'intelephense', args: ['--stdio'], label: 'Intelephense' },
  { language: 'c', command: 'clangd', args: [], label: 'clangd' },
  { language: 'cpp', command: 'clangd', args: [], label: 'clangd' },
  { language: 'lua', command: 'lua-language-server', args: [], label: 'lua-language-server' },
  { language: 'yaml', command: 'yaml-language-server', args: ['--stdio'], label: 'yaml-language-server' },
  { language: 'bash', command: 'bash-language-server', args: ['start'], label: 'bash-language-server' },
];

/** Aliases that share a server with a primary language id (so tsx/jsx reuse the TS server, etc.). */
const SERVER_ALIAS: Record<string, string> = {
  typescriptreact: 'typescript', javascript: 'typescript', javascriptreact: 'typescript',
  jsonc: 'json', scss: 'css', less: 'css',
  shellscript: 'bash', yml: 'yaml',
};

/** The LSP language id for a file path, or null when the extension isn't code we type-check. */
export function detectLanguage(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_LANGUAGE[ext] ?? null;
}

/** The server spec that handles a language id (following aliases), or null when none is registered. */
export function serverForLanguage(language: string): LanguageServerSpec | null {
  const canonical = SERVER_ALIAS[language] ?? language;
  return SERVERS.find((s) => s.language === canonical) ?? null;
}
