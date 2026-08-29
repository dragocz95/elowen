'use client';
/** Shared guards for rendering plugin-contributed UI: a plugin component is third-party code, so one
 *  broken render must stay INSIDE its slot (a /p/<plugin> page, a Settings section), never take down
 *  the shell around it. Used by the plugin host route and the Settings deck's plugin sections. */
import { Component as ReactComponent, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/** Class component — error boundaries have no hook equivalent. */
export class PluginErrorBoundary extends ReactComponent<{ children: ReactNode; notice: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render() {
    if (this.state.failed) return <PluginPlaceholder text={this.props.notice} />;
    return this.props.children;
  }
}

export function PluginPlaceholder({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </div>
  );
}
