interface AsyncPublicationToken<K extends string> {
  readonly lane: K;
  readonly generation: number;
  readonly epoch: number;
}

/** Generation fence for async UI publications that are not owned by a hydration lane (status/MCP and
 * provider rate limits). Session switch invalidates the epoch; teardown permanently closes the fence. */
export class ChatApplicationLifetime<K extends string> {
  private readonly generations = new Map<K, number>();
  private readonly controller = new AbortController();
  private epoch = 0;
  private active = true;

  /** One application-owned cancellation signal for local processes, clipboard readers and daemon I/O. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** Start asynchronous work inside this application's lifetime and publish only while it is still
   * active. Callers never need their own `stopped` flags, and an abort rejection cannot paint an error
   * into an already-restored terminal. */
  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void {
    if (!this.active) return;
    let pending: Promise<T>;
    try {
      pending = operation(this.signal);
    } catch (error) {
      if (this.active) onRejected?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    void pending.then(
      (value) => { if (this.active) onFulfilled(value); },
      (error: unknown) => {
        if (this.active) onRejected?.(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  begin(lane: K): AsyncPublicationToken<K> {
    const generation = (this.generations.get(lane) ?? 0) + 1;
    this.generations.set(lane, generation);
    return { lane, generation, epoch: this.epoch };
  }

  commit(token: AsyncPublicationToken<K>, publication: () => void): boolean {
    if (!this.current(token)) return false;
    publication();
    return true;
  }

  invalidate(): void { this.epoch += 1; }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch += 1;
    this.controller.abort(new Error('chat application stopped'));
  }

  private current(token: AsyncPublicationToken<K>): boolean {
    return this.active
      && token.epoch === this.epoch
      && this.generations.get(token.lane) === token.generation;
  }
}
