'use client';
import { shortToolName, toolIcon } from '../../lib/toolMeta';

/** What a turn actually did: the tools it ran, as icon-and-name pairs.
 *
 *  The feed used to say "worked · terminal ×4", which is true and tells you nothing. The tools are the
 *  only record of what the work WAS, so they are the row's content rather than a tooltip.
 *
 *  Drawn flat — one muted colour, no chips, no tinted backgrounds. The icon carries the identity and
 *  the spacing carries the separation, which keeps a busy row calm next to the pulse tile instead of
 *  turning the feed into a strip of badges. */

const MAX_SHOWN = 4;

export function ToolTrail({ tools }: { tools: { name: string; count: number }[] }) {
  if (!tools.length) return null;
  const shown = tools.slice(0, MAX_SHOWN);
  const hidden = tools.length - shown.length;

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-text-muted">
      {shown.map((tool) => {
        const Icon = toolIcon(tool.name);
        return (
          <span
            key={tool.name}
            title={tool.count > 1 ? `${tool.name} ×${tool.count}` : tool.name}
            className="inline-flex min-w-0 items-center gap-1"
          >
            <Icon size={12} className="shrink-0 text-text-subtle" aria-hidden />
            <span className="max-w-32 truncate">{shortToolName(tool.name)}</span>
            {tool.count > 1 ? (
              <span className="font-mono tabular-nums text-text-subtle">×{tool.count}</span>
            ) : null}
          </span>
        );
      })}
      {hidden > 0 ? (
        <span
          className="font-mono tabular-nums text-text-subtle"
          title={tools.slice(MAX_SHOWN).map((t) => t.name).join(', ')}
        >
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
