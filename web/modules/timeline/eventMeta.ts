import { ListChecks, Rocket, Radio, Circle, type LucideIcon } from 'lucide-react';
import type { Tone } from '../../components/ui/tone';

export function eventIcon(type: string): LucideIcon {
  switch (type) {
    case 'task': return ListChecks;
    case 'mission': return Rocket;
    case 'signal': return Radio;
    default: return Circle;
  }
}
export function eventTone(type: string): Tone {
  switch (type) {
    case 'task': return 'accent';
    case 'mission': return 'accent';
    case 'signal': return 'muted';
    default: return 'default';
  }
}
