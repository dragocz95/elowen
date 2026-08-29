'use client';
import { useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { elowenClient } from '../../lib/elowenClient';
import { Modal } from '../../components/ui/Modal';
import type { ProcessInfo } from '../../lib/types';

/** Live output of one background process, polled while it runs. Mirrors the terminal plugin's rolling
 *  buffer (read via GET /brain/processes/:id/output). Exported so the telemetry rail opens THIS detail
 *  instead of growing a second output view of its own. */
export function ProcessOutputModal({ proc, onClose }: { proc: ProcessInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [output, setOutput] = useState('');
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stale = false;
    const pull = async () => {
      const r = await elowenClient.brainProcessOutput(proc.id).catch(() => null);
      if (!stale && r) setOutput(r.output);
    };
    void pull();
    const timer = proc.running ? setInterval(() => void pull(), 1500) : null;
    return () => { stale = true; if (timer) clearInterval(timer); };
  }, [proc.id, proc.running]);
  useEffect(() => { preRef.current?.scrollTo({ top: preRef.current.scrollHeight }); }, [output]);
  return (
    // `inspect`: a live output tail. It is watched, never typed into.
    <Modal title={proc.command} description={proc.running ? t.processes.running : t.processes.exited} onClose={onClose} size="xl" icon={TerminalSquare} intent="inspect">
      <pre ref={preRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap bg-background p-4 font-mono text-tiny leading-relaxed text-muted-foreground">
        {output || t.processes.noOutput}
      </pre>
    </Modal>
  );
}


