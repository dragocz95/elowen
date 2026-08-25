import { Circle, Globe, Terminal, MessageCircle, Users, Send, Phone, Clock, type LucideIcon } from 'lucide-react';

/** Plugin activity kinds are opaque to core, so unknown kinds use a neutral mark. */
export function eventIcon(_type: string): LucideIcon { return Circle; }

/** Icon per activity SURFACE — the place a turn came from. An unrecognised surface (including the
 *  honest 'unknown' the daemon records when a client did not identify itself) falls back to a neutral
 *  dot rather than borrowing another platform's mark. */
export function surfaceIcon(surface: string): LucideIcon {
  switch (surface) {
    case 'web': return Globe;
    case 'cli': return Terminal;
    case 'discord': return MessageCircle;
    case 'msteams': return Users;
    case 'telegram': return Send;
    case 'whatsapp': return Phone;
    case 'cron': return Clock;
    default: return Circle;
  }
}
