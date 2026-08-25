'use client';
import { SquareArrowOutUpRight } from 'lucide-react';
import { StreamTerminal } from './StreamTerminal';
import { IconButton } from '../ui/IconButton';
import { openTerminalWindow } from '../../lib/openTerminalWindow';

export function TerminalPanel({ name }: { name: string; onKilled?: () => void }) {
  return <div className="flex h-full w-full flex-col">
    <div className="min-h-0 flex-1"><StreamTerminal name={name} /></div>
    <div className="flex items-center justify-end border-t border-border bg-surface px-3 py-2">
      <IconButton icon={SquareArrowOutUpRight} label="Open in new window" onClick={() => openTerminalWindow(name)} />
    </div>
  </div>;
}
