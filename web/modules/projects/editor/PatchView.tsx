/** Colored unified-diff view for a raw git patch (full commit, working tree, or a single file within
 *  a commit) — these come from git as patch text, not two file versions, so we render them inline. */
export function PatchView({ diff, empty }: { diff: string; empty: string }) {
  if (!diff.trim()) return <p className="p-4 text-center text-sm text-text-muted">{empty}</p>;
  return (
    <pre className="h-full overflow-auto bg-bg p-3 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => {
        const c = line.startsWith('+') && !line.startsWith('+++') ? 'text-success'
          : line.startsWith('-') && !line.startsWith('---') ? 'text-danger'
          : line.startsWith('@@') ? 'text-accent'
          : 'text-text-muted';
        return <div key={i} className={c}>{line || ' '}</div>;
      })}
    </pre>
  );
}
