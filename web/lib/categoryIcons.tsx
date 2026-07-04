'use client';
import {
  Briefcase, Server, Database, Heart, Code, Home, Star, Folder, Globe, Book,
  Cpu, Terminal, Rocket, Lightbulb, Target, Calendar, DollarSign, ShoppingCart,
  Music, Camera, MapPin, Zap, Flag, Bookmark,
  type LucideIcon,
} from 'lucide-react';

/** The shared 24-name lucide allowlist for memory-category icons. Kept byte-for-byte in sync with the
 *  daemon's server-side allowlist — the backend clamps any unknown/empty value to "Folder", so this is
 *  the single FE render source both category UIs import. Order here is the picker order. */
export const ICON_NAMES = [
  'Briefcase', 'Server', 'Database', 'Heart', 'Code', 'Home', 'Star', 'Folder',
  'Globe', 'Book', 'Cpu', 'Terminal', 'Rocket', 'Lightbulb', 'Target', 'Calendar',
  'DollarSign', 'ShoppingCart', 'Music', 'Camera', 'MapPin', 'Zap', 'Flag', 'Bookmark',
] as const;

type CategoryIconName = (typeof ICON_NAMES)[number];

/** name → lucide component. Lookups go through resolveIcon so unknown/empty falls back to Folder. */
const ICON_MAP: Record<CategoryIconName, LucideIcon> = {
  Briefcase, Server, Database, Heart, Code, Home, Star, Folder, Globe, Book,
  Cpu, Terminal, Rocket, Lightbulb, Target, Calendar, DollarSign, ShoppingCart,
  Music, Camera, MapPin, Zap, Flag, Bookmark,
};

/** The lucide component for an allowlist name, or the Folder fallback for anything unknown/empty. */
function resolveIcon(name: string | null | undefined): LucideIcon {
  if (name && name in ICON_MAP) return ICON_MAP[name as CategoryIconName];
  return Folder;
}

/** Render a category's icon by allowlist name. Fallback = Folder for unknown/empty. */
export function CategoryIcon({ name, size = 16, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const Icon = resolveIcon(name);
  return <Icon size={size} className={className} aria-hidden />;
}
