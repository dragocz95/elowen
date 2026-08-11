export interface BuildPluginUiBundleOptions {
  /** The bundle entry point (index.tsx/ts/jsx/js of the plugin's web sources). */
  entry: string;
  /** Where to write the single built ESM file (the plugin manifest's `web.entry`). */
  outfile: string;
  /** Minify the output (default false — the daemon serves it immutably either way). */
  minify?: boolean;
  /** Extra module resolution roots (NODE_PATH-style) for dependencies that live outside the plugin's
   *  own tree — e.g. the host web app's node_modules for icon libraries. */
  nodePaths?: string[];
}

/** Bundle `entry` into the ESM file at `outfile`. Throws on any build error. */
export declare function buildPluginUiBundle(options: BuildPluginUiBundleOptions): Promise<void>;
