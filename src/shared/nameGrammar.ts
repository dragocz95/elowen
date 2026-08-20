/** The one kebab-case name grammar for daemon-managed resources that are also a single path segment:
 *  agent names (`src/brain/agents/`) and plugin names (`src/plugins/marketplace.ts`). Two to 64 chars,
 *  lowercase letters, digits and dashes, first character not a dash.
 *
 *  It lives here rather than beside either caller because both enforce it on operator input that becomes
 *  a directory name — rejecting separators, `..`, absolute paths and the empty string at the source is
 *  the reason the traversal guards downstream have so little left to do. Keeping one copy means the
 *  create/delete APIs and the on-disk loaders cannot drift into disagreeing about what a legal name is.
 *
 *  Deliberately NOT shared with `THEME_NAME_RE` (`src/store/themeStore.ts`), which allows a one-character
 *  name: a theme is not addressed by the plugin/agent APIs and its own module documents the difference. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
