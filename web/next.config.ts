import type { NextConfig } from 'next';
import path from 'path';
const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Emit a self-contained server (server.js + a minimal node_modules) so the web UI can ship inside
  // the npm package and run with a bare `node server.js` — no `next` CLI, no full install. The build
  // bundle script copies in `.next/static` and `public/`, which standalone deliberately omits.
  output: 'standalone',
  // The same-origin daemon proxy is now the `app/api/[...path]` route handler, which (unlike a plain
  // rewrite) injects the daemon bearer from the httpOnly session cookie server-side. No rewrite needed.
  // Migration shim: PWAs installed before the dynamic manifest keep `/manifest.json` in their install
  // record forever — without this rewrite they would 404 on every launch and never pick up a rename.
  rewrites: async () => [{ source: '/manifest.json', destination: '/manifest.webmanifest' }],
};
export default nextConfig;
