import { spawn } from 'node:child_process';

/** Best-effort open a URL in the user's default browser. Returns true when an opener was launched, false
 *  when there's nothing to launch (headless box / SSH session) so the caller prints the URL as a fallback.
 *  The URL is passed as a SEPARATE argv element (never interpolated into a shell string), the child is
 *  detached + unref'd so the wizard never blocks on it, and a spawn error (e.g. xdg-open not installed)
 *  is swallowed — the caller has already printed the URL. */
export function openBrowser(url: string): boolean {
  // Over SSH the "browser" would open on the wrong machine — print the URL instead.
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  const plat = process.platform;
  const cmd =
    plat === 'darwin' ? { bin: 'open', args: [url] }
    // NOT `cmd /c start`: cmd.exe re-parses its argv, so the `&`/`%` every OAuth URL carries would split
    // the URL and execute the tail as a command. rundll32 opens the default browser with no shell parse.
    : plat === 'win32' ? { bin: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
    : (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? { bin: 'xdg-open', args: [url] }
    : null; // Linux without a display server → headless
  if (!cmd) return false;
  try {
    const child = spawn(cmd.bin, cmd.args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* opener missing — the caller already printed the URL */ });
    child.unref();
    return true;
  } catch { return false; }
}
