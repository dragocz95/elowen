import type { LucideIcon } from 'lucide-react';

export type ModuleGroup = 'Operate' | 'Config';

export interface ModuleMeta {
  id: string;
  label: string;
  route: string;
  icon: LucideIcon;
  group: ModuleGroup;
}
