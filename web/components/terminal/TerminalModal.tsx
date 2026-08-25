'use client';
import dynamic from 'next/dynamic';
import { TerminalSquare } from 'lucide-react';
import { Modal } from '../ui/Modal';

const TerminalPanel = dynamic(() => import('./TerminalPanel').then((m) => m.TerminalPanel), { ssr: false });

export function TerminalModal({ session, onClose }: { session: string; onClose: () => void }) {
  return (
    <Modal title="Terminal" description={session} onClose={onClose} icon={TerminalSquare}>
      <TerminalPanel name={session} onKilled={onClose} />
    </Modal>
  );
}
