interface AsyncPublicationToken<K extends string> {
  readonly lane: K;
  readonly generation: number;
  readonly epoch: number;
}

/** Long enough for the owned TERM→KILL process grace (250ms), but still below the daemon stop bound. */
export const APPLICATION_TASK_SHUTDOWN_MS = 350;

/** Generation fence for async UI publications that are not owned by a hydration lane (status/MCP and
 * provider rate limits). Session switch invalidates the epoch; teardown permanently closes the fence. */
export class ChatApplicationLifetime<K extends string> {
  private readonly generations = new Map<K, number>();
  private readonly controller = new AbortController();
  private readonly tasks = new Set<Promise<void>>();
  private epoch = 0;
  private active = true;
  private stopped: Promise<void> | null = null;

  /** One application-owned cancellation signal for local processes, clipboard readers and daemon I/O. */
  get signal(): AbortSignal { return this.controller.signal; }

  /** Start asynchronous work whose result remains relevant across conversation switches (for example,
   * provider management). It may publish until the application itself stops. */
  runApplication<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void {
    this.runTask(undefined, operation, onFulfilled, onRejected);
  }

  /** Start work owned by the currently selected conversation. A session switch advances `epoch`, so a
   * response from the old conversation can never repaint or restart resources in the new one. */
  runSession<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void {
    this.runTask(this.epoch, operation, onFulfilled, onRejected);
  }

  private runTask<T>(
    epoch: number | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    onFulfilled: (value: T) => void,
    onRejected?: (error: Error) => void,
  ): void {
    if (!this.active) return;
    const current = (): boolean => this.active && (epoch === undefined || epoch === this.epoch);
    let pending: Promise<T>;
    try {
      pending = operation(this.signal);
    } catch (error) {
      if (current()) onRejected?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const task = pending.then(
      (value) => { if (current()) onFulfilled(value); },
      (error: unknown) => {
        if (current()) onRejected?.(error instanceof Error ? error : new Error(String(error)));
      },
    );
    this.tasks.add(task);
    void task.then(
      () => { this.tasks.delete(task); },
      () => { this.tasks.delete(task); },
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

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.active = false;
    this.epoch += 1;
    this.controller.abort(new Error('chat application stopped'));
    const tasks = [...this.tasks];
    if (tasks.length === 0) {
      this.stopped = Promise.resolve();
      return this.stopped;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, APPLICATION_TASK_SHUTDOWN_MS);
    });
    this.stopped = Promise.race([
      Promise.allSettled(tasks).then(() => {}),
      timeout,
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return this.stopped;
  }

  private current(token: AsyncPublicationToken<K>): boolean {
    return this.active
      && token.epoch === this.epoch
      && this.generations.get(token.lane) === token.generation;
  }
}
