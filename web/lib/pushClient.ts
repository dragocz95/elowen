import { BASE } from './elowenClient';

// Client-side web-push helpers. Notification actions are presentation only: every click opens the
// authenticated app/deep-link and no service worker action calls a retired domain API.

export type PushActionPlan = { kind: 'open'; url: string };
interface PushActionData { url?: string }

export function actionToRequest(_action: string, data: PushActionData): PushActionPlan {
  return { kind: 'open', url: data.url ?? '/' };
}

export function isPushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;
}

/** Convert a URL-safe base64 VAPID public key to the Uint8Array PushManager.subscribe expects. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type EnablePushResult = 'granted' | 'denied' | 'unsupported';

/** Register the service worker, request notification permission, subscribe via PushManager and POST
 *  the subscription to the daemon. Must be called from a user gesture (permission prompt). */
export async function enablePush(): Promise<EnablePushResult> {
  if (!isPushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const { publicKey } = await (await fetch(`${BASE}/push/vapid-public-key`, { credentials: 'same-origin' })).json() as { publicKey: string };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
  const res = await fetch(`${BASE}/push/subscribe`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  });
  // Surface a daemon-side rejection (e.g. an expired session) instead of falsely reporting success.
  if (!res.ok) throw new Error(`subscribe failed: ${res.status}`);
  return 'granted';
}

/** Unsubscribe the current device and tell the daemon to forget it. */
export async function disablePush(): Promise<void> {
  if (!isPushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/sw.js');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await sub.unsubscribe();
  await fetch(`${BASE}/push/unsubscribe`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
}
