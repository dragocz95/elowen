'use client';
import { useEffect, useRef, useState } from 'react';
import { TerminalSquare } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { elowenClient } from '../../lib/elowenClient';
import { Modal, ModalBody } from '../../components/ui/Modal';
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
  // `ModalBody` owns the scroll, so the pane is sized by its output and following the tail means bringing
  // the pane's END edge into that one region — not scrolling the <pre>, which no longer overflows.
  useEffect(() => { preRef.current?.scrollIntoView?.({ block: 'end' }); }, [output]);
  return (
    // `inspect`: a live output tail. It is watched, never typed into.
    <Modal title={proc.command} description={proc.running ? t.processes.running : t.processes.exited} onClose={onClose} size="xl" icon={TerminalSquare} intent="inspect">
      <ModalBody>
        {/* The dark ground and the frame are the CODE PANE's own material — content, not the dialog's
            surface, which `.overlay-surface` already paints one level up. */}
        <pre ref={preRef} className="whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-tiny leading-relaxed text-muted-foreground">
          {output || t.processes.noOutput}
        </pre>
      </ModalBody>
    </Modal>
  );
}


