'use client';

/** What a turn actually did, as a row of coloured pills.
 *
 *  The feed used to say "worked · terminal ×4", which is true and tells you nothing. The tools are the
 *  only record of what the work WAS, so they are the row's content rather than a tooltip.
 *
 *  Colour encodes the KIND of work, not the individual tool: reading is calm blue, writing is amber,
 *  a shell command is the accent, because "did it change anything" is the question a glance is asking.
 *  That also keeps the palette to the same five tokens the pulse tile uses, so the two halves of the
 *  dashboard stay related and neither invents a colour of its own. */

type Kind = 'read' | 'write' | 'shell' | 'web' | 'agent' | 'other';

const KIND_COLOUR: Record<Kind, string> = {
  read: 'var(--color-info)',
  write: 'var(--color-warning)',
  shell: 'var(--color-accent)',
  web: 'var(--color-ember)',
  agent: 'var(--color-success)',
  other: 'var(--color-text-subtle)',
};

const EXACT: Record<string, Kind> = {
  Read: 'read', Grep: 'read', Search: 'read', Glob: 'read', ListDir: 'read', FileInfo: 'read',
  GitStatus: 'read', CodebaseSearch: 'read', DocsSearch: 'read', LspHover: 'read',
  Edit: 'write', Write: 'write', EditImage: 'write', GenerateImage: 'write',
  Bash: 'shell', KillProcess: 'shell', ProcessOutput: 'shell', ListProcesses: 'shell',
  WebFetch: 'web', WebSearch: 'web',
};

function kindOf(name: string): Kind {
  const exact = EXACT[name];
  if (exact) return exact;
  // Browser automation arrives as `mcp__chrome_devtools__*` and is unmistakably web work.
  if (name.startsWith('mcp__')) return 'web';
  if (name.startsWith('Delegate') || name.startsWith('Workflow')) return 'agent';
  return 'other';
}

/** `mcp__chrome_devtools__take_screenshot` reads as `take_screenshot`. The namespace is noise in a feed
 *  where the colour already says "browser", and the full name goes in the title attribute. */
function shortName(name: string): string {
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
}

const MAX_PILLS = 4;

export function ToolPills({ tools }: { tools: { name: string; count: number }[] }) {
  if (!tools.length) return null;
  const shown = tools.slice(0, MAX_PILLS);
  const hidden = tools.length - shown.length;

  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tool) => {
        const colour = KIND_COLOUR[kindOf(tool.name)];
        return (
          <span
            key={tool.name}
            title={tool.count > 1 ? `${tool.name} ×${tool.count}` : tool.name}
            className="inline-flex items-center gap-1 rounded-full py-px pl-1.5 pr-2 text-[10px] leading-4"
            // Tinted from the same colour as the dot, so a pill reads as one object rather than a chip
            // with a sticker on it. `color-mix` keeps it legible on the dark surface without a second token.
            style={{
              background: `color-mix(in oklab, ${colour} 14%, transparent)`,
              color: `color-mix(in oklab, ${colour} 82%, white)`,
            }}
          >
            <span aria-hidden className="h-1 w-1 shrink-0 rounded-full" style={{ background: colour }} />
            <span className="max-w-28 truncate">{shortName(tool.name)}</span>
            {tool.count > 1 ? <span className="font-mono tabular-nums opacity-70">×{tool.count}</span> : null}
          </span>
        );
      })}
      {hidden > 0 ? (
        <span className="font-mono text-[10px] tabular-nums text-text-subtle" title={tools.slice(MAX_PILLS).map((t) => t.name).join(', ')}>
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
