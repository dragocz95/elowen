import { LoadingLine } from './states';
/** Colored unified-diff view for a raw git patch (full commit, working tree, or a single file within
 *  a commit) — these come from git as patch text, not two file versions, so we render them inline. */
export function PatchView({ diff, empty, loading = false }: { diff: string; empty: string; loading?: boolean }) {
  // Without this every caller had to squeeze "loading" into `empty`, which told the user there were no
  // changes while the diff was still on its way.
  if (loading) return <div className="p-4"><LoadingLine /></div>;
  if (!diff.trim()) return <p className="p-4 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <pre className="h-full overflow-auto bg-background p-3 font-mono text-xs leading-relaxed">
      {diff.split('\n').map((line, i) => {
        const c = line.startsWith('+') && !line.startsWith('+++') ? 'text-success'
          : line.startsWith('-') && !line.startsWith('---') ? 'text-destructive'
          : line.startsWith('@@') ? 'text-primary'
          : 'text-muted-foreground';
        return <div key={i} className={c}>{line || ' '}</div>;
      })}
    </pre>
  );
}
