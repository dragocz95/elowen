import {
  Puzzle, Globe, Database, FolderOpen, TerminalSquare, GraduationCap, Image as ImageIcon,
  Wand2, Clapperboard, Clock, Activity, ShieldCheck, MessageCircle, Mic, Bell,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** Per-plugin visual identity: a recognizable icon instead of the one-size-fits-all puzzle piece.
 *  Names match plugin manifest names; unknown plugins fall back to the puzzle. */
const PLUGIN_ICONS: Record<string, LucideIcon> = {
  files: FolderOpen,
  terminal: TerminalSquare,
  web: Globe,
  memory: Database,
  skills: GraduationCap,
  'image-gen': ImageIcon,
  'image-edit': Wand2,
  video: Clapperboard,
  cron: Clock,
  statusline: Activity,
  'security-scan': ShieldCheck,
  discord: MessageCircle,
  tts: Mic,
  notify: Bell,
};

export function pluginIcon(name: string): LucideIcon {
  return PLUGIN_ICONS[name] ?? Puzzle;
}
