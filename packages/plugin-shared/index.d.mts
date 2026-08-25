/** Types for the package root. Only the contract version lives here — every helper is its own entry
 *  point and stays untyped .mjs, so this file exists purely to let a TypeScript consumer (the daemon's
 *  own manifest gate, a plugin built in TS) read the number without an ambient re-declaration that could
 *  drift from the value. */
export declare const PLUGIN_SHARED_API_VERSION: number;
