'use client';
import { useEffect, useRef, useState } from 'react';
import { QrCode, CheckCircle2, RefreshCw, Unlink } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { orcaClient } from '../../lib/orcaClient';
import { useTranslation } from '../../lib/i18n';
import type { WhatsAppPairing } from '../../lib/types';

/** The whatsapp-plugin "Pairing" controls (top of the Connection section): shows the current link state
 *  and offers either a "Pair device" button (opens a QR/code modal) or, when linked, a red "Unpair"
 *  button. Pairing state is read live off the running adapter. */
export function WhatsAppPairSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const refreshStatus = async () => {
    try { const s = await orcaClient.whatsappPairing(); setConnected(s.connected); }
    catch { setConnected(null); }
  };
  useEffect(() => { void refreshStatus(); }, []);

  const doUnpair = async () => {
    setConfirmUnpair(false);
    try { await orcaClient.whatsappUnpair(); } catch { /* ignore — status refresh reflects reality */ }
    await refreshStatus();
  };

  return (
    <div className="mb-2 space-y-3 border-b border-border pb-4">
      <p className="text-sm text-text-muted">{t.pluginDetail.waPairHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-sm text-success"><CheckCircle2 size={16} aria-hidden /> {t.pluginDetail.waPairConnected}</span>
            <Button variant="danger" icon={Unlink} onClick={() => setConfirmUnpair(true)}>{t.pluginDetail.waUnpairButton}</Button>
          </>
        ) : (
          <Button variant="accent" icon={QrCode} onClick={() => setOpen(true)}>{t.pluginDetail.waPairButton}</Button>
        )}
      </div>
      {open ? <PairModal onClose={() => { setOpen(false); void refreshStatus(); }} /> : null}
      <ConfirmDialog
        open={confirmUnpair}
        title={t.pluginDetail.waUnpairButton}
        description={t.pluginDetail.waUnpairConfirm}
        confirmLabel={t.pluginDetail.waUnpairButton}
        onConfirm={doUnpair}
        onClose={() => setConfirmUnpair(false)}
      />
    </div>
  );
}

function PairModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<WhatsAppPairing | null>(null);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await orcaClient.whatsappPairing();
        if (!alive) return;
        setState(s); setError(false);
        if (s.connected) stop();
      } catch { if (alive) setError(true); }
    };
    // Kick a fresh pairing attempt (new QR / phone code), then poll until linked.
    void (async () => {
      try { await orcaClient.whatsappPair(); } catch { if (alive) setError(true); }
      await poll();
    })();
    timer.current = setInterval(poll, 1500);
    return () => { alive = false; stop(); };
  }, []);

  const refresh = async () => {
    try { await orcaClient.whatsappPair(); setError(false); } catch { setError(true); }
  };

  const connected = state?.connected === true;
  return (
    <Modal title={t.pluginDetail.waPairTitle} icon={QrCode} size="sm" onClose={onClose}>
      <ModalBody>
        {error ? (
          <p className="text-sm text-danger">{t.pluginDetail.waPairError}</p>
        ) : connected ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 size={48} className="text-success" aria-hidden />
            <p className="text-sm text-text">{t.pluginDetail.waPairConnected}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            {state?.qrImage ? (
              <>
                <p className="text-sm text-text-muted">{t.pluginDetail.waPairScan}</p>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data-URL QR, no remote host */}
                <img src={state.qrImage} alt="WhatsApp QR" width={280} height={280} className="rounded-md bg-white p-2" />
              </>
            ) : (
              <p className="py-6 text-sm text-text-muted">{t.pluginDetail.waPairWaiting}</p>
            )}
            {state?.code ? (
              <div className="w-full border-t border-border pt-3">
                <p className="text-sm text-text-muted">{t.pluginDetail.waPairCode}</p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-text">{state.code}</p>
              </div>
            ) : null}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        {!connected && !error ? (
          <Button variant="ghost" icon={RefreshCw} onClick={refresh}>{t.pluginDetail.waPairRefresh}</Button>
        ) : null}
        <Button variant="accent" onClick={onClose}>{connected ? 'OK' : t.common.close}</Button>
      </ModalFooter>
    </Modal>
  );
}
