'use client';

import { Switch } from './shadcn/switch';

export function Toggle({ checked, onChange, label, disabled = false }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      style={{ transitionDuration: 'var(--motion-fast)' }}
    />
  );
}
