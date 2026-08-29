import { pluginIcon } from './pluginMeta';

/** One visual language for every plugin: a semantic Lucide glyph in the same neutral frame. Package
 *  brand assets may still exist for external/marketplace use, but never make the in-app catalog noisy
 *  or unreadable on OLED themes. `hasIcon` stays in the public props for third-party compatibility. */
export function PluginIcon({ name, size = 24 }: { name: string; hasIcon?: boolean; size?: number }) {
  const radius = Math.round(size * 0.23);
  const Icon = pluginIcon(name);
  return (
    <span
      className="flex shrink-0 items-center justify-center border border-border bg-muted text-muted-foreground"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <Icon size={Math.round(size * 0.46)} aria-hidden />
    </span>
  );
}
