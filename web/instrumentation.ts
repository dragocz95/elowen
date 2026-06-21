import { logger, LOG_DIR } from './lib/serverLogger';

const log = logger('web');

/** Next.js server-startup hook — runs once when the web server boots (Node runtime only). Records the
 *  start in the shared logs/ folder so the web process leaves a trail alongside the daemon. */
export function register(): void {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    log.info(`web server started — logs → ${LOG_DIR}`);
  }
}

/** Next.js server-side error hook — every uncaught error in a Server Component / route / middleware
 *  lands here. Mirror it into the shared log so server faults aren't lost to the console alone. */
export function onRequestError(err: unknown, request: { path?: string; method?: string }): void {
  log.error(`request error ${request.method ?? ''} ${request.path ?? ''}`.trim(), err);
}
