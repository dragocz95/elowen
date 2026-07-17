/** Single source of truth for the tool→output-visibility policy, resolved exactly like tool icons
 *  (see `toolIcons.ts`). Which tools' successful output shows in the chat transcript is a declarative
 *  SHOW-allowlist that lives WITH the tool that owns it — a tool's output is HIDDEN by default and
 *  surfaces only when its name is on the allowlist. The brain's built-in tools declare theirs co-located
 *  in `src/brain/tools/index.ts` (BUILTIN_TOOL_OUTPUT_SHOWN), a plugin declares its own in the manifest
 *  (`showOutput`). The daemon merges both and injects a resolver into the shared `messageView`
 *  renderer, so the live path (events.ts), the history path (shapeBrainMessages) and every client
 *  (CLI, web, Discord) key off the ONE policy.
 *
 *  A shown tool's output surfaces only on SUCCESS-or-anything; a tool NOT on the allowlist stays hidden
 *  on SUCCESS but its FAILURE (warning/danger tone) or a hook-appended note always surfaces (that
 *  override lives in `toolOutputView`). Keeping the noisy Read/List/Grep/memory output hidden is also
 *  what lets the renderers collapse repeated same-tool rows into one `Read … ×N` line (there's no
 *  per-item output block to keep them apart).
 *
 *  Keys may be an exact tool name or a `prefix*` pattern (e.g. `Lsp*`); a match by either shows. */

/** Whether a tool's successful output is shown in the transcript. */
export type ToolOutputPolicy = (name: string) => boolean;

/** Build a policy over a live set of show patterns (built-in defaults + plugin manifest `showOutput`).
 *  `patterns` is a thunk so the resolver reads the current set every call — a newly enabled plugin's
 *  policy applies without a daemon restart, mirroring how icons are re-resolved per session spawn. */
export function makeToolOutputPolicy(patterns: () => Iterable<string>): ToolOutputPolicy {
  return (name: string): boolean => {
    for (const p of patterns()) {
      if (p.endsWith('*')) { if (name.startsWith(p.slice(0, -1))) return true; }
      else if (name === p) return true;
    }
    return false;
  };
}
