import { ListChecks, Rocket, Radio, ShieldCheck, Circle, type LucideIcon } from 'lucide-react';

/** Icon per activity-event kind. Host-owned: the activity log is a core surface (the dashboard tile,
 *  `/activity`) that outlives whichever plugin produced the event. */
export function eventIcon(type: string): LucideIcon {
  switch (type) {
    case 'task': return ListChecks;
    case 'mission': return Rocket;
    case 'signal': return Radio;
    case 'review': return ShieldCheck;
    default: return Circle;
  }
}
