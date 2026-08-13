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
const PATTERNS: { re: RegExp; label: (m: RegExpMatchArray) => string }[] = [
  { re: /(?:detail\.)?name === '([a-z0-9-]+)'/g, label: (m) => m[0] },
  { re: /use(?:PluginDetail|PluginPresent|DomainReachable)\('([a-z0-9-]+)'\)/g, label: (m) => m[0] },
  { re: /['"`]\/p\/([a-z0-9-]+)/g, label: (m) => `/p/${m[1]}` },
];

/** Every binding core is still allowed to carry, keyed by file → matched text → why it may stay.
 *  A reason must say what makes it legitimate or what would remove it — never just "existing". */
const ALLOWED: Record<string, Record<string, string>> = {
  'components/shell/CommandPalette.tsx': {
    '/p/work': 'Core command palette entries, each already gated on workUi/agentsUi; the target route is the work plugin\'s own. Removal path: let a plugin contribute its palette commands through the UI runtime.',
  },
  'components/shell/OrbitalNav.tsx': {
    '/p/work': 'The nav ORDER is core (which slot a world occupies) while the worlds themselves come from the plugin listing; an unlisted plugin simply never claims its slot. Removal path: a manifest-declared nav weight.',
    '/p/agents': 'Same ordered-slot list — the order is core, the world is not.',
    '/p/editor': 'Same ordered-slot list — the order is core, the world is not.',
  },
  'components/shell/TopBar.tsx': {
    '/p/agents': 'Page-title resolution for a plugin route, already gated on agentsUi. Removal path: page titles declared by the plugin manifest instead of matched by pathname.',
  },
  'components/ui/NotificationBell.tsx': {
    '/p/agents': 'Escalation link inside a bell section already gated on agentsUi && workUi. Removal path: the notification source declares its own target route.',
  },
  'lib/queries.ts': {
    "usePluginPresent('agents')": 'The presence hooks ARE the name→boolean boundary: something has to name the plugin once so every other surface can ask a domain question instead. Keeping them here is what keeps the names out of the components.',
    "usePluginPresent('editor')": 'Same single presence boundary.',
    "usePluginPresent('cronjob')": 'Same single presence boundary.',
    "usePluginPresent('work')": 'Same single presence boundary.',
    "useDomainReachable('work')": 'Same single boundary, for the fetch gates (a disabled plugin\'s routes answer 503).',
    "useDomainReachable('agents')": 'Same single boundary, for the fetch gates.',
  },
  'lib/useDockState.ts': {
    "name === 'string'": 'Not a plugin name — a `typeof x.name === \'string\'` runtime guard on persisted dock state.',
  },
  'modules/advisor/BrainChatProvider.tsx': {
    "name === 'model'": 'Not a plugin name — a built-in SLASH COMMAND name from the core command catalog.',
    "name === 'new'": 'Built-in slash command.',
    "name === 'status'": 'Built-in slash command.',
    "name === 'help'": 'Built-in slash command.',
    "name === 'stats'": 'Built-in slash command.',
    "name === 'skills'": 'Built-in slash command.',
    "name === 'rename'": 'Built-in slash command.',
  },
  'modules/dashboard/HeroCosmos.tsx': {
    '/p/agents': 'Dashboard pod target, rendered only when that pod\'s plugin gate is on. Removal path: pods contributed by the owning plugin through the UI runtime.',
    '/p/cronjob': 'Same dashboard pod set, same removal path.',
    '/p/work': 'Same dashboard pod set (already `work ? … : undefined`), same removal path.',
  },
  'modules/dashboard/HeroNowTile.tsx': {
    '/p/work': 'Hero tile target chosen behind useWorkPlugin(); falls back to /chat when the plugin is absent. Same removal path as the dashboard pods.',
    '/p/agents': 'Same hero tile, chosen behind agentsUi.',
  },
  'modules/projects/ProjectsView.tsx': {
    '/p/editor': 'Opens the extracted editor on a project/commit, behind an editorEnabled gate. Removal path: the editor plugin declares the "open this project here" target it wants links to use.',
  },
  'modules/settings/GithubSection.tsx': {
    "usePluginDetail('agents')": 'prEnabled/ghToken are the agents plugin\'s config slice, edited from a core settings section. Removal path: move the whole GitHub section into that plugin\'s settings deck.',
  },
  'modules/settings/PluginConfigEditor.tsx': {
    "detail.name === 'msteams'": 'The Teams app-package section is not extracted yet.',
  },
  'modules/settings/PluginLivePreview.tsx': {
    "name === 'discord'": 'Decorative per-platform config preview rendered inside the core schema editor; extraction candidate for a later batch.',
    "name === 'whatsapp'": 'Same live-preview set.',
    "name === 'cronjob'": 'Same live-preview set.',
    "name === 'terminal'": 'Same live-preview set.',
  },
  // The redirect shims exist ONLY to name the new plugin route: they keep pre-extraction bookmarks and
  // links working, so naming the target is the entire feature and there is no removal path.
  'app/tasks/page.tsx': { '/p/work': 'Redirect shim for a pre-extraction bookmark (/tasks) — naming the target route is its only job.' },
  'app/kanban/page.tsx': { '/p/work': 'Redirect shim for a pre-extraction bookmark (/kanban).' },
  'app/timeline/page.tsx': { '/p/work': 'Redirect shim for a pre-extraction bookmark (/timeline).' },
  'app/stats/page.tsx': { '/p/work': 'Redirect shim for a pre-extraction bookmark (/stats).' },
  'app/sessions/page.tsx': { '/p/agents': 'Redirect shim for a pre-extraction bookmark (/sessions).' },
  'app/escalations/page.tsx': { '/p/agents': 'Redirect shim for a pre-extraction bookmark (/escalations).' },
  'app/editor/page.tsx': { '/p/editor': 'Redirect shim for a pre-extraction bookmark (/editor).' },
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
