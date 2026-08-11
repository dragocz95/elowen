#!/usr/bin/env node
import { buildPluginUiBundle } from './build.js';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: elowen-plugin-ui-build <entry> <outfile>');
  process.exit(2);
}
await buildPluginUiBundle({ entry, outfile });
