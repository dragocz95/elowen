/** Global short-lived hydration/transport replay limits. These are deliberately shared by the CLI
 * history hydrator and the SSE route that buffers events before its atomic snapshot has flushed. */
export const HYDRATION_MAX_EVENTS = 2_048;
export const HYDRATION_MAX_BYTES = 4 * 1024 * 1024;

export interface SerializedEventBufferLimits {
  maxEvents?: number;
  maxBytes?: number;
}

export type SerializedEventAppendResult = 'accepted' | 'overflow';

/** A raw-event buffer with deterministic serialized UTF-8 accounting. It intentionally does not
 * coalesce deltas: the acceptance contract is expressed in raw input events, and an overflow invalidates
 * the complete replay rather than retaining a misleading suffix. */
export class SerializedEventBuffer<T> {
  private entries: T[] = [];
  private serializedBytes = 0;
  private invalid = false;
  private readonly encoder = new TextEncoder();
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(limits: SerializedEventBufferLimits = {}) {
    this.maxEvents = limits.maxEvents ?? HYDRATION_MAX_EVENTS;
    this.maxBytes = limits.maxBytes ?? HYDRATION_MAX_BYTES;
  }

  get count(): number { return this.entries.length; }
  get bytes(): number { return this.serializedBytes; }
  get overflowed(): boolean { return this.invalid; }

  append(value: T): SerializedEventAppendResult {
    if (this.invalid) return 'overflow';
    let bytes: number;
    try {
      const json = JSON.stringify(value);
      if (typeof json !== 'string') return this.overflow();
      bytes = this.encoder.encode(json).byteLength;
    } catch {
      return this.overflow();
    }
    if (this.entries.length + 1 > this.maxEvents || this.serializedBytes + bytes > this.maxBytes) {
      return this.overflow();
    }
    this.entries.push(value);
    this.serializedBytes += bytes;
    return 'accepted';
  }

  values(): readonly T[] { return this.entries.slice(); }

  drain(): T[] {
    const values = this.entries;
    this.entries = [];
    this.serializedBytes = 0;
    this.invalid = false;
    return values;
  }

  clear(): void {
    this.entries = [];
    this.serializedBytes = 0;
    this.invalid = false;
  }

  private overflow(): 'overflow' {
    this.entries = [];
    this.serializedBytes = 0;
    this.invalid = true;
    return 'overflow';
  }
}
