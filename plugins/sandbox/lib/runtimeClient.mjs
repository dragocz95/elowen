/** The runtime client interface, written down.
 *
 *  `environmentRuntime.mjs` and `containerStorage.mjs` drive an environment through ONE injected object.
 *  `NspawnClient` is the only implementation, and the surface is stated here rather than inferred from it:
 *  the typedef below is the complete list of methods those two modules actually call.
 *
 *  Two of the names below read as a container runtime's because that is where they came from, and they
 *  are the METHOD's vocabulary now:
 *
 *  - `containerInventory(namespace)` is a name→state map. HOW a client finds the envelopes of a namespace
 *    is its own business: nspawn filters `machinectl list` by the namespace name prefix. The map is the
 *    contract.
 *  - `inspect(spec)` returns `{ id, state }` where `state` is the runtime-neutral vocabulary
 *    `configured | created | running | paused | stopped | exited | stopping`, which nspawn maps
 *    `ActiveState`/`SubState`/`FreezerState` onto.
 *
 *  `id` is not a container id. It is the immutable, host-derived envelope identity that
 *  `bindContainerIdentity` pins into a specification: 64 hex characters, stable while the envelope is
 *  unchanged, different the moment it changes.
 *
 * @typedef {object} RuntimeClient
 *
 * Envelope identity and lifecycle.
 * @property {(spec: object) => Promise<{ id: string, state: string } | null>} inspect Ownership-proved
 *   identity and state, or null when no envelope of this name exists. Throws on an ownership mismatch.
 * @property {(spec: object) => Promise<boolean>} containerExists Name-only presence, with no ownership
 *   proof, so an envelope built from a superseded specification can still be REPORTED.
 * @property {(namespace: string) => Promise<Map<string, string>>} containerInventory
 * @property {(spec: object) => Promise<{ id: string, state: string }>} create
 * @property {(spec: object) => Promise<void>} start
 * @property {(spec: object, timeoutSeconds?: number) => Promise<void>} stop
 * @property {(spec: object) => Promise<void>} remove
 * @property {(spec: object) => Promise<void>} removeByName
 * @property {(spec: object) => Promise<void>} pause
 * @property {(spec: object) => Promise<void>} unpause
 * @property {(spec: object, options?: { timeoutMs?: number }) => Promise<void>} waitForSystemBus
 * @property {(spec: object, options?: { timeoutMs?: number }) => Promise<string>} systemRunning
 * @property {(spec: object, limits: object) => Promise<object>} update Applies limits live and returns
 *   the specification that records them.
 *
 * Guest execution and its leases.
 * @property {(spec: object, executionId: string, argv: string[], options?: object) => Promise<{ code: number, stdout: string, stderr: string, truncated: boolean }>} exec
 * @property {(spec: object, executionId: string, argv: string[], options?: object) => Promise<object>} prepareExecution
 * @property {(spec: object, executionId: string, options?: { persistent?: boolean }) => Promise<object>} cancelExecution
 * @property {(spec: object, executionId: string, options?: { persistent?: boolean }) => Promise<void>} releaseExecution
 * @property {(spec: object, executionId: string, argv: string[]) => Promise<void>} startPreview
 * @property {(spec: object, publicationId: string, argv: string[]) => Promise<void>} startPublication
 * @property {(spec: object, publicationId: string) => Promise<void>} stopPublication
 * @property {(spec: object, publicationIds: string[]) => Promise<string[]>} activePublications
 *
 * Disk trees. Every path is host-derived and re-validated by the client against the trusted roots.
 * @property {(spec: object, pendingPath: string, options?: object) => Promise<string>} materializeRootfs
 * @property {(spec: object) => Promise<{ uidBase: number, uidSize: number, entries: number }>} shiftOwnership
 *   Re-stamps the disk's identity record from the specification and puts the tree on the machine's uid
 *   range. Idempotent: a tree already in range is left alone, byte for byte.
 * @property {(spec: object, archivePath: string, targetPath: string) => Promise<void>} extractRootfsArchive
 * @property {(archivePath: string, targetPath: string) => Promise<{ members: number }>} verifyExtractedRootfs
 * @property {(sourcePath: string, targetPath: string) => Promise<void>} copyDiskTree
 * @property {(path: string) => Promise<{ logicalBytes: number, allocatedBytes: number, digest: string }>} fingerprintDiskTree
 * @property {(path: string) => Promise<void>} syncDiskTree
 * @property {(sourcePaths: string[], destinationPath: string) => Promise<object>} preflightDiskCopy
 * @property {(path: string) => Promise<void>} removeDiskPath
 * @property {(spec: object) => Promise<void>} removeStorage
 * @property {(spec: object) => Promise<void>} removeGenerationStorage
 * @property {(spec: object, snapshotId: string) => Promise<void>} removeSnapshotStorage
 * @property {(spec: object, snapshotId: string) => Promise<void>} discardIncompleteSnapshot
 * @property {(spec: object, operation: 'import' | 'export', archivePath: string) => Promise<void>} siteDataArchive
 *   Seeds a Site's `data` tree from an archive, or captures it into one. An import replaces the tree
 *   atomically and only while the environment is stopped; an export never overwrites its destination.
 *
 * Host readiness. The machine runtime needs its host prepared before it can hold an environment at all.
 * @property {() => Promise<{ ready: boolean, items: { id: string, label: string, ok: boolean, detail?: string }[] }>} [hostReadiness]
 */

/** Which runtime owns this specification.
 *
 *  There is one runtime, and `disk.runtime` is the persisted proof that a row belongs to it. A row without
 *  it was written by a release that ran containers, and there is no rule that turns a container into a
 *  machine: its root filesystem was never materialized from a published artifact, and its envelope
 *  identity was hashed from a specification this release no longer produces. So it is NAMED and refused
 *  rather than adopted, in the same shape and with the same remedy as `parseArtifactReference` uses for a
 *  disk that still names a container image tag.
 *
 * @param {object} spec
 * @param {{ nspawn?: RuntimeClient | null }} clients
 * @returns {RuntimeClient}
 */
export function selectRuntimeClient(spec, clients) {
  const runtime = spec?.disk?.runtime;
  if (runtime !== 'nspawn') {
    throw Object.assign(new Error(`This environment runs on ${runtime ?? 'a container runtime'}, which this release no longer runs; delete the environment and create it again to build it from a published root filesystem`), { code: 'unsupported_runtime', status: 409 });
  }
  if (!clients.nspawn) throw new Error('This environment runs on systemd-nspawn, which is unavailable');
  return clients.nspawn;
}
