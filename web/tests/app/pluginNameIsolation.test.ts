import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Architectural invariant of the plugin-extraction work: the CORE web app must not special-case a
 *  plugin BY NAME. A plugin's own surfaces (settings deck, pages, routes) ship in its web-src bundle and
 *  exist only while that plugin is enabled; core code that hardcodes `'agents'` or `/p/work/...` silently
 *  breaks — or silently keeps rendering — when the plugin is renamed, replaced or switched off.
 *
 *  This greps the WHOLE core web app (not just the settings modules, which is all the first version of
 *  this guard looked at) for the four shapes that bind core to a plugin name:
 *    - `name === 'x'` / `detail.name === 'x'` — dispatch on a plugin's name;
 *    - `usePluginDetail('x')` / `usePluginPresent('x')` / `useDomainReachable('x')` — a name-keyed read;
 *    - a hardcoded `/p/<plugin>` route.
 *  Everything that legitimately exists today is listed in ALLOWED below WITH ITS REASON, so a new binding
 *  fails CI instead of joining an unexplained pile. Stale entries fail too: an allowance whose code is
 *  gone must be deleted, or the list stops describing the app.  */
const SKIP_DIRS = new Set(['node_modules', '.next', 'tests', 'test-results', 'public', 'skins', 'deploy', 'scripts']);

/** `label` is what the allowlist is keyed on. A route is normalized to `/p/<plugin>` — the binding is the
 *  PLUGIN NAME, not which of its pages a link points at, and normalizing keeps the list from churning
 *  every time a plugin page moves or a query string is added. */
/** `typeof x.name === 'string'` is a runtime type guard, not a dispatch on a plugin's name, so the
 *  primitive type names are excluded from the match itself rather than allowlisted per file — otherwise
 *  every new guard on an untrusted `name` field has to buy its way onto the list with a reason that is
 *  always the same one. No plugin is called `string`. */
const TYPEOF_RESULTS = 'string|number|bigint|boolean|symbol|undefined|object|function';

const PATTERNS: { re: RegExp; label: (m: RegExpMatchArray) => string }[] = [
  { re: new RegExp(`(?:detail\\.)?name === '(?!(?:${TYPEOF_RESULTS})')([a-z0-9-]+)'`, 'g'), label: (m) => m[0] },
  { re: /use(?:PluginDetail|PluginPresent|DomainReachable)\('([a-z0-9-]+)'\)/g, label: (m) => m[0] },
  { re: /['"`]\/p\/([a-z0-9-]+)/g, label: (m) => `/p/${m[1]}` },
];

/** Every binding core is still allowed to carry, keyed by file → matched text → why it may stay.
 *  A reason must say what makes it legitimate or what would remove it — never just "existing". */
const ALLOWED: Record<string, Record<string, string>> = {
  'app/editor/page.tsx': {
    '/p/editor': 'Legacy /editor bookmarks redirect to the optional editor plugin route.',
  },
  'components/shell/navOrder.ts': {
    '/p/editor': 'The default nav order gives the optional editor integration a stable slot.',
    '/p/subagent': 'The default nav order gives the bundled subagent integration a stable slot.',
    '/p/cronjob': 'The default nav order gives the bundled scheduler integration a stable slot.',
    '/p/skills': 'The default nav order gives the bundled skills integration a stable slot.',
    '/p/stats': 'The default nav order gives the bundled statistics integration a stable slot.',
  },
  'components/ui/ProjectIcon.tsx': {
    "usePluginPresent('editor')": 'Project icons are served by the optional editor integration and hide when it is absent.',
  },
  'modules/dashboard/MetricsTile.tsx': {
    "usePluginPresent('cronjob')": 'The next-run figure reads a schedule only the scheduler integration owns; asking without it earns a 503 and the figure would read "nothing scheduled" for an instance that has no scheduler at all.',
    '/p/cronjob': 'That same figure links to the schedule it reports.',
    "usePluginPresent('stats')": 'The month figure is core usage and renders either way — only its LINK is gated, because the page it opens belongs to the statistics integration.',
    '/p/stats': 'Target of that gated link.',
  },
  'modules/projects/ProjectsView.tsx': {
    "usePluginPresent('editor')": 'Project editor actions are gated on the optional editor integration.',
    '/p/editor': 'The gated project action opens the optional editor integration.',
  },
  'modules/settings/PluginConfigEditor.tsx': {
    "detail.name === 'msteams'": 'The Teams app-package section has a product-specific payload shape.',
  },
  'modules/advisor/BrainChatProvider.tsx': {
    "name === 'model'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'new'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'help'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'stats'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'reasoning'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'skills'": 'Built-in slash-command name, not a plugin dispatch.',
    "name === 'tasks'": 'Built-in session-checklist command, not a plugin dispatch.',
    "name === 'rename'": 'Built-in slash-command name, not a plugin dispatch.',
  },
};

/** Drop whole-line comments before matching. A plugin name in prose (`… as /p/skills/settings/skills
 *  repeats the name back at the reader`) documents the routing rule, it does not BIND core to a plugin,
 *  and allowlisting documentation would make the list churn on every wording change. Only lines that
 *  START as a comment are dropped, so nothing executable can hide behind this. */
const stripComments = (src: string): string =>
  src.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');

function sourceFiles(dir: string, into: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, into);
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) into.push(full);
  }
  return into;
}

describe('the core web app does not special-case plugins by name', () => {
  const root = process.cwd();
  const found = new Map<string, Set<string>>(); // file → matched texts
  for (const file of sourceFiles(root, [])) {
    const rel = relative(root, file);
    const src = stripComments(readFileSync(file, 'utf-8'));
    for (const { re, label } of PATTERNS) {
      for (const m of src.matchAll(re)) {
        if (!found.has(rel)) found.set(rel, new Set());
        found.get(rel)!.add(label(m));
      }
    }
  }

  it('carries no plugin-name binding outside the documented allowlist', () => {
    const offenders: string[] = [];
    for (const [file, matches] of found) {
      for (const match of matches) if (!ALLOWED[file]?.[match]) offenders.push(`${file}: ${match}`);
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('has no stale allowlist entry (an allowance whose code is gone must be deleted)', () => {
    const stale: string[] = [];
    for (const [file, matches] of Object.entries(ALLOWED)) {
      for (const match of Object.keys(matches)) if (!found.get(file)?.has(match)) stale.push(`${file}: ${match}`);
    }
    expect(stale.sort()).toEqual([]);
  });

  it('gives every allowance a reason', () => {
    const unexplained: string[] = [];
    for (const [file, matches] of Object.entries(ALLOWED)) {
      for (const [match, reason] of Object.entries(matches)) {
        if (reason.trim().length < 20) unexplained.push(`${file}: ${match}`);
      }
    }
    expect(unexplained).toEqual([]);
  });
});
