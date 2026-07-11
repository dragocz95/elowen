type HydrationNoticeLane = 'parent' | 'child';

interface HydrationNoticeSeed {
  /** Persistent launch warning (for example invalid keybinds), independent from transient notices. */
  base?: string;
  external?: string;
  parent?: string;
  child?: string;
}

/** Structured ownership for hydration notices layered over the TUI's existing transient notice slot.
 * Exact strings are retained as values; ANSI content is never parsed or split. If another feature
 * replaces the rendered value, that whole value becomes the external notice preserved on recovery. */
export class HydrationNoticeOwner {
  private readonly base: string;
  private external: string;
  private readonly lanes: Record<HydrationNoticeLane, string>;
  private rendered: string;

  constructor(seed: HydrationNoticeSeed = {}) {
    this.base = seed.base ?? '';
    this.external = seed.external ?? '';
    this.lanes = { parent: seed.parent ?? '', child: seed.child ?? '' };
    this.rendered = this.compose();
  }

  render(): string {
    this.rendered = this.compose();
    return this.rendered;
  }

  publish(lane: HydrationNoticeLane, message: string, current: string): string {
    this.observeExternal(current);
    this.lanes[lane] = message;
    return this.render();
  }

  clear(lane: HydrationNoticeLane, current: string): string {
    this.observeExternal(current);
    this.lanes[lane] = '';
    return this.render();
  }

  private observeExternal(current: string): void {
    if (current !== this.rendered) this.external = current;
  }

  private compose(): string {
    return [this.base, this.external, this.lanes.parent, this.lanes.child].filter(Boolean).join(' · ');
  }
}
