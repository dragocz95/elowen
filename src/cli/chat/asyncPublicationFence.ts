interface AsyncPublicationToken<K extends string> {
  readonly lane: K;
  readonly generation: number;
  readonly epoch: number;
}

/** Generation fence for async UI publications that are not owned by a hydration lane (status/MCP and
 * provider rate limits). Session switch invalidates the epoch; teardown permanently closes the fence. */
export class AsyncPublicationFence<K extends string> {
  private readonly generations = new Map<K, number>();
  private epoch = 0;
  private active = true;

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
  }

  private current(token: AsyncPublicationToken<K>): boolean {
    return this.active
      && token.epoch === this.epoch
      && this.generations.get(token.lane) === token.generation;
  }
}
