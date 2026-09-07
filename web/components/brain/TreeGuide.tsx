/** The connector that ties a nested row to the conversation it hangs under: the trunk running down the
 *  branch, and the elbow into this row. It replaces a plain indent, which left a schedule looking like a
 *  loose row that happened to start further right instead of one belonging to the conversation above it.
 *
 *  Drawn as two rules rather than typed as `└─`, because a glyph's position depends on the font and would
 *  drift from the row rhythm; these are pinned to the middle of the row whatever its height. The trunk
 *  stops halfway down the LAST row of a branch, which is what closes the group visually.
 *
 *  The negative block margin is deliberate: a register row's box stops short of the next one by the
 *  grid's own `padding-block` and its bottom hairline, so a trunk drawn only inside the cell would come
 *  out dashed. The caller's cell needs `self-stretch` for the same reason — a register row centres its
 *  cells, so without it the guide is only as tall as the text beside it. */
export function TreeGuide({ last }: { last: boolean }) {
  return (
    <span aria-hidden data-tree-guide={last ? 'last' : 'branch'} className="relative -my-1.5 w-5 shrink-0 self-stretch">
      <span className={`absolute left-1/2 top-0 w-px bg-border ${last ? 'h-1/2' : 'h-full'}`} />
      <span className="absolute left-1/2 top-1/2 h-px w-1/2 bg-border" />
    </span>
  );
}
