import { useEffect, useRef, useState } from 'react';
import { QrCode, CheckCircle2, RefreshCw, Unlink } from 'lucide-react';
import { runtime, type WhatsAppPairing } from './runtime';

const pairing = () => runtime().api('/plugins/whatsapp/pairing') as Promise<WhatsAppPairing>;
const pair = () => runtime().api('/plugins/whatsapp/pair', { method: 'POST' });
const unpair = () => runtime().api('/plugins/whatsapp/unpair', { method: 'POST' });

/** The whatsapp plugin's "Pairing" settings-deck section: shows the current link state and offers
 *  either a "Pair device" button (opens a QR/code modal) or, when linked, a red "Unpair" button.
 *  Pairing state is read live off the running adapter. */
export function PairingSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('whatsapp');
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);

  const refreshStatus = async () => {
    try { const st = await pairing(); setConnected(st.connected); }
    catch { setConnected(null); }
  };
  useEffect(() => { void refreshStatus(); }, []);

  const doUnpair = async () => {
    setConfirmUnpair(false);
    try { await unpair(); } catch { /* ignore — status refresh reflects reality */ }
    await refreshStatus();
  };

  return (
    <C.PluginSection surface={surface} className="plugin-card" icon={QrCode} title={s.pairTitle} description={s.pairHint}>
      <div className="settings-group__panel space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {connected ? (
            // Paired state reads from the action itself — the red "Unpair" is only shown when linked,
            // so no redundant "connected!" banner is needed.
            <C.Button variant="danger" icon={Unlink} onClick={() => setConfirmUnpair(true)}>{s.unpairButton}</C.Button>
          ) : (
            <C.Button variant="accent" icon={QrCode} onClick={() => setOpen(true)}>{s.pairButton}</C.Button>
          )}
        </div>
        {open ? <PairModal onClose={() => { setOpen(false); void refreshStatus(); }} /> : null}
        <C.ConfirmDialog
          open={confirmUnpair}
          title={s.unpairButton}
          description={s.unpairConfirm}
          confirmLabel={s.unpairButton}
          onConfirm={doUnpair}
          onClose={() => setConfirmUnpair(false)}
        />
      </div>
    </C.PluginSection>
  );
}

function PairModal({ onClose }: { onClose: () => void }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('whatsapp');
  const [state, setState] = useState<WhatsAppPairing | null>(null);
  const [error, setError] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const st = await pairing();
        if (!alive) return;
        setState(st); setError(false);
        if (st.connected) stop();
      } catch { if (alive) setError(true); }
    };
    // Kick a fresh pairing attempt (new QR / phone code), then poll until linked.
    void (async () => {
      try { await pair(); } catch { if (alive) setError(true); }
      await poll();
    })();
    timer.current = setInterval(poll, 1500);
    return () => { alive = false; stop(); };
  }, []);

  const refresh = async () => {
    try { await pair(); setError(false); } catch { setError(true); }
  };

  const connected = state?.connected === true;
  return (
    <C.Modal title={s.pairModalTitle} icon={QrCode} size="sm" onClose={onClose}>
      <C.ModalBody>
        {error ? (
          <p className="text-sm text-danger">{s.pairError}</p>
        ) : connected ? (
          // Success is shown by the check + the footer flipping to "OK"; no wording needed.
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 size={48} className="text-success" aria-hidden />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            {state?.qrImage ? (
              <>
                <p className="text-sm text-text-muted">{s.pairScan}</p>
                <img src={state.qrImage} alt="WhatsApp QR" width={280} height={280} className="rounded-md bg-white p-2" />
              </>
            ) : (
              <p className="py-6 text-sm text-text-muted">{s.pairWaiting}</p>
            )}
            {state?.code ? (
              <div className="w-full border-t border-border pt-3">
                <p className="text-sm text-text-muted">{s.pairCode}</p>
                <p className="mt-1 font-mono text-2xl font-bold tracking-widest text-text">{state.code}</p>
              </div>
            ) : null}
          </div>
        )}
      </C.ModalBody>
      <C.ModalFooter>
        {!connected && !error ? (
          <C.Button variant="ghost" icon={RefreshCw} onClick={refresh}>{s.pairRefresh}</C.Button>
        ) : null}
        <C.Button variant="accent" onClick={onClose}>{connected ? 'OK' : s.close}</C.Button>
      </C.ModalFooter>
    </C.Modal>
  );
}
