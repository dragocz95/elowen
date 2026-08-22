// Elowen service worker: renders web-push notifications and runs their inline actions. The daemon
// (src/push/) builds every payload, so there is no i18n here — text is rendered verbatim. The
// action→request mapping mirrors web/lib/pushClient.ts `actionToRequest`; keep the two in sync.
const SW_VERSION = '2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function parsePayload(data) {
  try {
    return data ? data.json() : null;
  } catch (_e) {
    return null;
  }
}

// --- instance branding -------------------------------------------------------
// The artwork on a phone notification is resolved HERE rather than carried in the payload, because
// payloads come from several builders — the daemon's own turn notification and the mission
// notifications built inside the agents plugin — and a payload field would brand only whichever of
// them remembered to set it.
const THEME_URL = '/api/public/theme';
const THEME_CACHE = 'elowen-theme';
const FALLBACK_ICON = '/elowen-logo.png';
const FALLBACK_NAME = 'Elowen';
// Mirrors THEME_ASSET_PATH_RE in web/lib/brandShared.ts: a payload must never be able to steer the
// notification artwork at an arbitrary daemon route.
const ASSET_PATH_RE = /^\/public\/theme\/assets\/[a-z0-9-]+\.(png|svg)\?v=[0-9a-f]{16}$/;

/** The public white-label payload, network-first with a cached fallback. Network-first so a theme
 *  switch reaches the next notification; cached fallback so a slow or unreachable daemon still
 *  produces a branded one. The route is unauthenticated by design. */
async function themePayload() {
  const cache = await caches.open(THEME_CACHE);
  try {
    const res = await fetch(THEME_URL, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      await cache.put(THEME_URL, res.clone());
      return await res.json();
    }
  } catch (_e) { /* offline, slow or aborted — fall through to whatever was cached */ }
  const hit = await cache.match(THEME_URL);
  if (!hit) return null;
  try {
    return await hit.json();
  } catch (_e) {
    return null;
  }
}

/** Never let branding cost a notification: any failure degrades to the bundled Elowen assets. */
async function branding() {
  let payload = null;
  try {
    payload = await themePayload();
  } catch (_e) { /* keep the fallbacks */ }
  const assets = (payload && payload.assets) || {};
  // icon192 rather than the tab favicon: this is the artwork a phone renders at notification size.
  const path = assets.icon192;
  const brand = (payload && payload.brand) || {};
  return {
    icon: path && ASSET_PATH_RE.test(path) ? '/api' + path : FALLBACK_ICON,
    name: brand.productName || FALLBACK_NAME,
  };
}

async function showPush(p) {
  const brand = await branding();
  if (!p) {
    return self.registration.showNotification(brand.name, {
      body: 'Nová událost.',
      badge: brand.icon,
      icon: brand.icon,
    });
  }
  return self.registration.showNotification(p.title, {
    body: p.body,
    tag: p.missionId || undefined, // collapse repeat notifications about the same mission
    data: p,
    actions: Array.isArray(p.actions) ? p.actions : [],
    badge: brand.icon,
    icon: brand.icon,
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(parsePayload(event.data)));
});

// Same-origin path mirror of pushClient.ts actionToRequest (plain JS — public/ is not bundled).
function actionToRequest(action, data) {
  switch (action) {
    case 'approve':
      return { kind: 'fetch', steps: [{ method: 'POST', path: '/api/tasks/' + data.taskId + '/approve-gate' }] };
    case 'rerun':
      return { kind: 'fetch', steps: [
        { method: 'PATCH', path: '/api/tasks/' + data.taskId, body: { status: 'open' } },
        { method: 'PATCH', path: '/api/missions/' + data.missionId, body: { action: 'resume' } },
      ] };
    case 'allow':
      return { kind: 'fetch', steps: [{ method: 'POST', path: '/api/sessions/' + encodeURIComponent(data.session || '') + '/keys', body: { keys: ['Enter'] } }] };
    case 'reject':
      return { kind: 'fetch', steps: [{ method: 'POST', path: '/api/sessions/' + encodeURIComponent(data.session || '') + '/keys', body: { keys: ['Escape'] } }] };
    default:
      return { kind: 'open', url: data.url || '/' };
  }
}

async function runSteps(steps) {
  for (const step of steps) {
    const res = await fetch(step.path, {
      method: step.method,
      credentials: 'same-origin',
      headers: step.body ? { 'content-type': 'application/json' } : undefined,
      body: step.body ? JSON.stringify(step.body) : undefined,
    });
    if (!res.ok) throw new Error('step failed: ' + res.status);
  }
}

// Only open a same-origin app path or an https URL (e.g. a GitHub PR). Reject anything else
// (javascript:/data: or an off-origin redirect) so a payload url can never become an open-redirect.
function safeOpenUrl(raw) {
  try {
    const u = new URL(raw || '/', self.location.origin);
    if (u.origin === self.location.origin || u.protocol === 'https:') return u.href;
  } catch (_e) { /* fall through */ }
  return self.location.origin + '/';
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const plan = actionToRequest(event.action, data);
  if (plan.kind === 'open') {
    event.waitUntil(self.clients.openWindow(safeOpenUrl(plan.url)));
    return;
  }
  event.waitUntil(
    runSteps(plan.steps).catch(() =>
      self.registration.showNotification('Akce se nezdařila', { body: 'Otevřete aplikaci a zkuste to znovu.', data }),
    ),
  );
});
