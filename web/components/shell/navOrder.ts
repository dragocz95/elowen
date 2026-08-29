/** The default sequence of the primary navigation, shared by every shell presentation.
 *
 *  Top to bottom: where you land, then project context and automation, then administration. This is only
 *  the UNTOUCHED default — a user's own arrangement overrides it entirely — but it has to be the same
 *  default everywhere, or switching the design would silently re-sort a menu nobody touched. Unknown
 *  plugin worlds stay dynamic and fall after the named platform integrations rather than being
 *  special-cased.
 *
 *  This is the navigation MODEL's ordering rule, not a presentation detail, which is why it lives beside
 *  navEntry.ts rather than inside the component that happened to need it first. */
export const NAV_ROUTE_ORDER = [
  '/dash', '/chat',
  '/projects', '/p/editor',
  '/p/subagent', '/p/cronjob', '/p/skills',
  '/memory', '/p/stats',
  '/account', '/users', '/settings',
];

/** Where an entry parks in that sequence. Prefix matching lets a plugin's nested pages share its slot; an
 *  unmatched dynamic plugin falls after the administration block. */
export function navOrderIndex(href: string | undefined): number {
  if (!href) return Number.MAX_SAFE_INTEGER;
  const index = NAV_ROUTE_ORDER.findIndex((route) => href === route || href.startsWith(`${route}/`));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}
