#!/usr/bin/env node
/** Thin bin launcher: verify the Node runtime BEFORE importing the CLI module graph. The real CLI pulls in
 *  the PI SDK, whose undici build needs worker_threads.markAsUncloneable (Node >= 22) — on an older Node
 *  that import chain dies with a cryptic undici TypeError long before any of our code runs. A newcomer on
 *  a distro-default Node must get one clear sentence instead of a stack trace. */
const MIN_NODE_MAJOR = 22;

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
  process.stderr.write(
    `elowen requires Node.js ${MIN_NODE_MAJOR} or newer — you are running ${process.version}.\n` +
    `Upgrade Node (e.g. https://nodejs.org or your version manager) and run this command again.\n`,
  );
  process.exit(1);
}

const { main } = await import('./index.js');
await main().catch((e: Error) => { console.error(e.message); process.exit(1); });
