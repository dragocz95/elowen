import { ListChecks, Rocket, Radio, ShieldCheck, Circle, Globe, Terminal, MessageCircle, Users, Send, Phone, Clock, Bot, type LucideIcon } from 'lucide-react';

/** Icon per activity-event kind. Host-owned: the activity log is a core surface (the dashboard tile,
 *  `/activity`) that outlives whichever plugin produced the event. */
export function eventIcon(type: string): LucideIcon {
  switch (type) {
    case 'task': return ListChecks;
    case 'mission': return Rocket;
    case 'signal': return Radio;
    case 'review': return ShieldCheck;
    // A team-feed turn is drawn by the surface it came FROM (see surfaceIcon) — where someone works is
    // the informative part; that they sent a message is the same for every row.
    case 'turn': return MessageCircle;
    default: return Circle;
  }
}

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
    case 'subagent': return Bot;
    case 'task': return ListChecks;
    default: return Circle;
  }
}
