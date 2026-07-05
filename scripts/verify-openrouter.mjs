// Verifies OpenRouter app-attribution is correctly configured for THIS deployment:
//   1. the outbound identity headers Orca sends (HTTP-Referer + X-OpenRouter-Title/X-Title) match
//      the configured app URL/title;
//   2. the public app URL serves a favicon at /favicon.ico WITHOUT auth (OpenRouter scrapes it from the
//      referer to render the app's icon on its ranking page).
//
// Run after a build (reads dist/) and after setting ORCA_APP_URL/ORCA_APP_TITLE for prod:
//   node scripts/verify-openrouter.mjs
//
// Exit code 0 = all good; 1 = a check failed. After deploy, also eyeball the app on
// https://openrouter.ai/apps (search for the X-Title) to confirm OpenRouter recognized it.
import { APP_URL, APP_TITLE, APP_IDENTITY_HEADERS } from '../dist/inference/appIdentity.js';

let failed = false;
const ok = (msg) => console.log(`  ok   ${msg}`);
const bad = (msg) => { console.error(`  FAIL ${msg}`); failed = true; };

console.log(`OpenRouter attribution — APP_URL=${APP_URL} APP_TITLE=${APP_TITLE}`);

// 1) Outbound headers. OpenRouter reads HTTP-Referer + X-OpenRouter-Title; X-Title is a compatibility
// alias for older compatible relays. There is no categories header.
const keys = Object.keys(APP_IDENTITY_HEADERS).sort();
if (keys.join(',') === 'http-referer,x-openrouter-title,x-title') ok('identity headers are exactly http-referer + x-openrouter-title + x-title');
else bad(`unexpected identity header set: ${keys.join(', ')}`);
if (APP_IDENTITY_HEADERS['http-referer'] === APP_URL) ok('http-referer matches APP_URL');
else bad(`http-referer (${APP_IDENTITY_HEADERS['http-referer']}) != APP_URL (${APP_URL})`);
if (APP_IDENTITY_HEADERS['x-openrouter-title'] === APP_TITLE) ok('x-openrouter-title matches APP_TITLE');
else bad(`x-openrouter-title (${APP_IDENTITY_HEADERS['x-openrouter-title']}) != APP_TITLE (${APP_TITLE})`);
if (APP_IDENTITY_HEADERS['x-title'] === APP_TITLE) ok('x-title matches APP_TITLE');
else bad(`x-title (${APP_IDENTITY_HEADERS['x-title']}) != APP_TITLE (${APP_TITLE})`);
if (/^https:\/\//.test(APP_URL)) ok('APP_URL is https');
else bad('APP_URL is not https — OpenRouter expects a public https referer');

// 2) Favicon reachable, unauthenticated, image content-type, no cross-host redirect.
const faviconUrl = `${APP_URL}/favicon.ico`;
try {
  const res = await fetch(faviconUrl, { redirect: 'follow' });
  const ctype = res.headers.get('content-type') ?? '';
  if (res.status === 200) ok(`GET ${faviconUrl} -> 200`);
  else bad(`GET ${faviconUrl} -> ${res.status} (expected 200; OpenRouter won't find the icon)`);
  if (/^image\//.test(ctype)) ok(`favicon content-type is ${ctype}`);
  else bad(`favicon content-type is "${ctype}" (expected image/*)`);
  if (new URL(res.url).origin === new URL(APP_URL).origin) ok('favicon not redirected off-origin');
  else bad(`favicon redirected to ${res.url} (off the referer origin)`);
} catch (e) {
  bad(`fetch ${faviconUrl} threw: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: OK');
process.exit(failed ? 1 : 0);
