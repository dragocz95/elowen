import { Image, getCapabilities, truncateToWidth } from '@earendil-works/pi-tui';
import type { ImageProtocol } from '@earendil-works/pi-tui';
import type { BrainInlineArtifact, BrainInlineArtifactClosed } from '../../brain/events.js';
import type { ArtifactMediaFrame } from './brainClient.js';
import { terminalInlineText } from '../ui/text.js';
import { color } from './theme.js';

const ARTIFACT_CHANGE_JOURNAL_LIMIT = 1_024;
export const INLINE_ARTIFACT_FRAME_INTERVAL_MS = 500;

export type InlineArtifactFrame = ArtifactMediaFrame;

export interface InlineArtifactChange {
  kind: 'full' | 'tools' | 'none';
  toolCallIds: string[];
  revision: number;
}

type ArtifactMutation = { toolCallIds: string[] };
type ArtifactListener = (toolCallIds: readonly string[]) => void;

export function inlineArtifactKey(artifact: Pick<BrainInlineArtifact, 'plugin' | 'id'>): string {
  return `${artifact.plugin}\0${artifact.id}`;
}

/** Durable open-artifact projection for one transcript. Media frames stay outside this collection: they are
 * transient, high-frequency presentation state and must never turn history replacement into an O(history)
 * operation. */
export class InlineArtifactCollection {
  private artifacts = new Map<string, BrainInlineArtifact>();
  private readonly changes = new Map<number, ArtifactMutation>();
  private readonly listeners = new Set<ArtifactListener>();
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

  subscribe(listener: ArtifactListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(toolCallIds: string[]): void {
    if (toolCallIds.length === 0 && this.currentRevision > 0) return;
    const revision = ++this.currentRevision;
    this.changes.set(revision, { toolCallIds });
    while (this.changes.size > ARTIFACT_CHANGE_JOURNAL_LIMIT) {
      this.changes.delete(this.changes.keys().next().value as number);
    }
    for (const listener of this.listeners) listener(toolCallIds);
  }
}

export interface ArtifactFrameStream {
  (path: string, onFrame: (frame: InlineArtifactFrame) => void, signal: AbortSignal): Promise<void>;
}

interface FrameControllerDeps {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/** Owns one live-media connection and a one-element latest-frame queue. The first frame paints immediately;
 * bursts collapse to the newest frame and publish at most twice per second. */
export class InlineArtifactFrameController {
  private readonly ac = new AbortController();
  private pending: InlineArtifactFrame | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    path: string,
    stream: ArtifactFrameStream,
    private readonly publishFrame: (frame: InlineArtifactFrame) => void,
    deps: FrameControllerDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    void stream(path, (frame) => this.enqueue(frame), this.ac.signal).catch(() => { /* reconnect owner reports no UI error */ });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = null;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.ac.abort();
  }

  private enqueue(frame: InlineArtifactFrame): void {
    if (this.stopped) return;
    this.pending = frame;
    if (this.timer) return;
    const wait = Math.max(0, INLINE_ARTIFACT_FRAME_INTERVAL_MS - (this.now() - this.lastPublishedAt));
    if (wait === 0) this.flush();
    else this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped || !this.pending) return;
    const frame = this.pending;
    this.pending = null;
    this.lastPublishedAt = this.now();
    this.publishFrame(frame);
  }
}

interface ThumbnailBounds { maxWidthCells: number; maxHeightCells: number }

/** One Image instance per accepted media frame. Kitty receives the previous image id so the placement is
 * replaced in place; iTerm2 deliberately gets no stable id and its caller requests a full redraw. */
export class ArtifactThumbnail {
  private frame: InlineArtifactFrame | null = null;
  private image: Image | null = null;
  private imageId: number | undefined;
  private protocol: ImageProtocol = null;
  private bounds: ThumbnailBounds | null = null;

  update(frame: InlineArtifactFrame, protocol: ImageProtocol, bounds: ThumbnailBounds): void {
    this.frame = frame;
    this.protocol = protocol;
    this.bounds = bounds;
    if (protocol !== 'kitty') this.imageId = undefined;
    this.image = new Image(frame.data, frame.mimeType, { fallbackColor: color.dim }, {
      maxWidthCells: bounds.maxWidthCells,
      maxHeightCells: bounds.maxHeightCells,
      ...(protocol === 'kitty' && this.imageId !== undefined ? { imageId: this.imageId } : {}),
    });
  }

  render(width: number, protocol: ImageProtocol, bounds: ThumbnailBounds): string[] {
    if (!this.frame) return [];
    if (!this.image || this.protocol !== protocol
      || this.bounds?.maxWidthCells !== bounds.maxWidthCells
      || this.bounds?.maxHeightCells !== bounds.maxHeightCells) {
      this.update(this.frame, protocol, bounds);
    }
    const lines = this.image!.render(width);
    this.imageId = protocol === 'kitty' ? this.image!.getImageId() : undefined;
    return lines;
  }

  getImageId(): number | undefined { return this.imageId; }
}

interface PresenterEntry {
  artifact: BrainInlineArtifact;
  path: string;
  controller?: InlineArtifactFrameController;
  thumbnail: ArtifactThumbnail;
}

export interface InlineArtifactPresenterOptions {
  collection: InlineArtifactCollection;
  stream: ArtifactFrameStream;
  maxHeightCells: () => number;
  onInvalidate: (toolCallId: string, fullRedraw: boolean) => void;
}

/** Bridges durable artifact state to transient media controllers and terminal rendering. It is generic over
 * plugin/view names: only the host artifact contract (fallback + optional SSE media path) is interpreted. */
export class InlineArtifactPresenter {
  private readonly entries = new Map<string, PresenterEntry>();
  private readonly unsubscribe: () => void;
  private protocol: ImageProtocol = null;
  private stopped = false;
  private lastRenderWidth = 80;

  constructor(private readonly options: InlineArtifactPresenterOptions) {
    this.protocol = getCapabilities().images;
    this.unsubscribe = options.collection.subscribe((toolCallIds) => {
      this.sync();
      for (const id of toolCallIds) options.onInvalidate(id, this.protocol === 'iterm2');
    });
    this.sync();
  }

  render(toolCallId: string, width: number): string[] {
    this.lastRenderWidth = width;
    this.sync();
    const artifacts = this.options.collection.forToolCall(toolCallId);
    const rows: string[] = [];
    for (const artifact of artifacts) {
      const fallback = terminalInlineText(artifact.fallback).trim() || artifact.view;
      rows.push(`      ${color.dim(truncateToWidth(fallback, Math.max(1, width - 6), '…'))}`);
      if (!this.protocol || !artifact.media) continue;
      const entry = this.entries.get(inlineArtifactKey(artifact));
      if (!entry) continue;
      const bounds = this.bounds(width);
      rows.push(...entry.thumbnail.render(width, this.protocol, bounds));
    }
    return rows;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    for (const entry of this.entries.values()) entry.controller?.stop();
    this.entries.clear();
  }

  private bounds(width: number): ThumbnailBounds {
    return {
      maxWidthCells: Math.max(8, Math.min(72, Math.floor(width * 0.7))),
      maxHeightCells: Math.max(3, Math.min(18, this.options.maxHeightCells())),
    };
  }

  private sync(): void {
    if (this.stopped) return;
    const nextProtocol = getCapabilities().images;
    if (nextProtocol !== this.protocol) {
      for (const entry of this.entries.values()) entry.controller?.stop();
      this.entries.clear();
      this.protocol = nextProtocol;
    }
    const wanted = new Map(this.options.collection.all().map((artifact) => [inlineArtifactKey(artifact), artifact]));
    for (const [key, entry] of this.entries) {
      const artifact = wanted.get(key);
      if (!this.protocol || !artifact?.media || artifact.media.path !== entry.path) {
        entry.controller?.stop();
        this.entries.delete(key);
      } else {
        entry.artifact = artifact;
      }
    }
    if (!this.protocol) return;
    for (const [key, artifact] of wanted) {
      if (!artifact.media || this.entries.has(key)) continue;
      const thumbnail = new ArtifactThumbnail();
      const entry: PresenterEntry = {
        artifact,
        path: artifact.media.path,
        thumbnail,
      };
      this.entries.set(key, entry);
      entry.controller = new InlineArtifactFrameController(
        artifact.media.path,
        this.options.stream,
        (frame) => {
          const current = this.entries.get(key);
          if (!current || current !== entry) return;
          thumbnail.update(frame, this.protocol, this.bounds(this.lastRenderWidth));
          this.options.onInvalidate(current.artifact.toolCallId, this.protocol === 'iterm2');
        },
      );
    }
  }
}
