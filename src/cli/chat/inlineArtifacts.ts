import type { BrainInlineArtifact, BrainInlineArtifactClosed } from '../../brain/events.js';

const ARTIFACT_CHANGE_JOURNAL_LIMIT = 1_024;

export interface InlineArtifactChange {
  kind: 'full' | 'tools' | 'none';
  toolCallIds: string[];
  revision: number;
}

type ArtifactMutation = { toolCallIds: string[] };

export function inlineArtifactKey(artifact: Pick<BrainInlineArtifact, 'plugin' | 'id'>): string {
  return `${artifact.plugin}\0${artifact.id}`;
}

/** Durable open-artifact projection for one transcript. The CLI renders an artifact as its textual fallback
 * row only; live media belongs to the web UI, which owns the single live-view path. */
export class InlineArtifactCollection {
  private artifacts = new Map<string, BrainInlineArtifact>();
  private readonly changes = new Map<number, ArtifactMutation>();
  private currentRevision = 0;

  constructor(seed: readonly BrainInlineArtifact[] = []) {
    this.replace(seed);
  }

  get revision(): number { return this.currentRevision; }

  all(): readonly BrainInlineArtifact[] { return [...this.artifacts.values()]; }

  forToolCall(toolCallId: string): readonly BrainInlineArtifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.toolCallId === toolCallId);
  }

  replace(next: readonly BrainInlineArtifact[]): void {
    const replacement = new Map(next.map((artifact) => [inlineArtifactKey(artifact), artifact]));
    const changed = new Set<string>();
    for (const artifact of this.artifacts.values()) changed.add(artifact.toolCallId);
    for (const artifact of replacement.values()) changed.add(artifact.toolCallId);
    this.artifacts = replacement;
    this.publish([...changed]);
  }

  apply(artifact: BrainInlineArtifact | BrainInlineArtifactClosed): boolean {
    const key = inlineArtifactKey(artifact);
    if (artifact.status === 'closed') {
      const current = this.artifacts.get(key);
      if (!current) return false;
      this.artifacts.delete(key);
      this.publish([current.toolCallId]);
      return true;
    }
    const previous = this.artifacts.get(key);
    this.artifacts.set(key, artifact);
    this.publish(previous && previous.toolCallId !== artifact.toolCallId
      ? [previous.toolCallId, artifact.toolCallId]
      : [artifact.toolCallId]);
    return true;
  }

  changesSince(revision: number): InlineArtifactChange {
    if (revision === this.currentRevision) return { kind: 'none', toolCallIds: [], revision };
    if (revision < 0 || revision > this.currentRevision) {
      return { kind: 'full', toolCallIds: [], revision: this.currentRevision };
    }
    const toolCallIds = new Set<string>();
    for (let next = revision + 1; next <= this.currentRevision; next++) {
      const change = this.changes.get(next);
      if (!change) return { kind: 'full', toolCallIds: [], revision: this.currentRevision };
      for (const id of change.toolCallIds) toolCallIds.add(id);
    }
    return { kind: 'tools', toolCallIds: [...toolCallIds], revision: this.currentRevision };
  }

  private publish(toolCallIds: string[]): void {
    if (toolCallIds.length === 0 && this.currentRevision > 0) return;
    const revision = ++this.currentRevision;
    this.changes.set(revision, { toolCallIds });
    while (this.changes.size > ARTIFACT_CHANGE_JOURNAL_LIMIT) {
      this.changes.delete(this.changes.keys().next().value as number);
    }
  }
}
