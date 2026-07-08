// Web-native config endpoint (NOT proxied to the daemon): tells the browser how to reach the terminal
// WebSocket. In proxy-less IP mode the install sets ELOWEN_WS_DIRECT_PORT to the daemon's public port, so
// the browser connects straight to `ws://<host>:<port>/ws/terminal`. Behind a proxy / on localhost the
// var is unset and the client falls back to the same-origin `/ws/` path. A specific route segment wins
// over the catch-all BFF proxy, so this never hits the daemon — it just surfaces the web's own env.
export function GET(): Response {
  const raw = process.env.ELOWEN_WS_DIRECT_PORT;
  const port = raw ? Number(raw) : NaN;
  const directPort = Number.isInteger(port) && port > 0 ? port : null;
  return Response.json({ directPort });
}
