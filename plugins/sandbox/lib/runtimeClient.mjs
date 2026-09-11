/** The runtime client interface, written down.
 *
 *  `environmentRuntime.mjs` and `containerStorage.mjs` drive an environment through ONE injected object.
 *  For most of this runtime's life that object was a `PodmanClient` and the interface was whatever
 *  `PodmanClient` happened to expose. `NspawnClient` is a sibling behind the same surface, so the surface
 *  has to be stated rather than inferred: the typedef below is the complete list of methods those two
 *  modules actually call, and a client that answers all of them is a runtime.
 *
 *  Three places used to carry Podman's own shape through the interface and are narrowed here rather than
 *  emulated on the other side:
 *
 *  - `containerInventory(namespace)` is a name→state map. HOW a client finds the envelopes of a namespace
 *    is its own business: Podman queries its ownership label, nspawn filters `machinectl list` by the
 *    namespace name prefix. The map is the contract; the label filter never was.
 *  - `inspect(spec)` returns `{ id, state }` where `state` is the runtime-neutral vocabulary
 *    `configured | created | running | paused | stopped | exited | stopping`. It reads as Podman's because
 *    Podman is where it came from, but it is the METHOD's vocabulary now: nspawn maps
 *    `ActiveState`/`SubState`/`FreezerState` onto it, and the runtime never learns a second one.
 *  - The volume methods are legacy-only. A disk-backed environment mounts the disk's own directories and
 *    owns no named handles, which `podman.mjs` already reflects by skipping them whenever `spec.disk` is
 *    set. They stay on the interface because legacy image-backed rows still reach them; a client with no
 *    volume store refuses them instead of emulating one.
 *
 *  `id` is likewise not a Podman container id. It is the immutable, host-derived envelope identity that
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
 * @property {(spec: object, pendingPath: string) => Promise<string>} materializeRootfs
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
 *
 * Images. A runtime without an image store delegates these to one that has one; it never pretends.
 * @property {(dataDir: string, onOutput?: (line: string) => void) => Promise<string>} ensureProjectImage
 * @property {(dataDir: string, recipe: object) => Promise<string>} ensureSiteImage
 * @property {(reference: string) => Promise<{ present: boolean, imageId: string | null }>} imageStatus
 * @property {(reference: string) => Promise<string>} imageIdentity
 * @property {(spec: object, snapshotId: string) => Promise<string>} snapshotImage
 * @property {(spec: object, snapshotId: string) => Promise<string>} inspectSnapshotImage
 * @property {(spec: object, snapshotId: string) => Promise<void>} removeSnapshotImage
 * @property {(spec: object, reference: string) => Promise<string>} discoverRetainedSiteImage
 * @property {(spec: object, reference: string, imageId: string) => Promise<string>} inspectRetainedSiteImage
 * @property {(spec: object, reference: string, imageId: string) => Promise<void>} removeRetainedSiteImage
 *
 * Legacy image-backed migration sources. A disk-backed specification is refused by both clients.
 * @property {(spec: object, destinationPath: string) => Promise<object>} preflightRootfsMigration
 * @property {(spec: object, archivePath: string) => Promise<string>} exportContainerRootfs
 * @property {(spec: object, options?: { target?: string, uidBase?: number | null }) => Promise<object>} [shiftOwnership]
 *   The one-time ownership pass a RUNTIME change needs, and the only way back from it. Provided by the
 *   target of `migrate-runtime` alone; nothing else on this interface reaches for it.
 *
 * Named volumes. Legacy-only: a disk-backed specification never reaches them, and a client with no
 * volume store refuses them.
 * @property {(spec: object, component: string) => Promise<object>} ensureVolume
 * @property {(spec: object, component: string) => Promise<object>} inspectVolume
 * @property {(spec: object, component: string) => Promise<void>} removeVolume
 * @property {(spec: object, component: string, snapshotId: string) => Promise<void>} exportVolume
 * @property {(sourceSpec: object, snapshotId: string, targetSpec: object, component: string, options?: { resume?: boolean }) => Promise<void>} importSnapshotVolume
 * @property {(spec: object, operation: string, archivePath: string) => Promise<void>} siteDataArchive
 */

/** Which runtime owns this specification. `disk.runtime` is persisted data on the disk record and the
 *  ONLY discriminator: absent means Podman, which is every environment that exists before an explicit
 *  `migrate-runtime`. There is no configuration flag and no registry.
 *
 * @param {object} spec
 * @param {{ podman: RuntimeClient, nspawn?: RuntimeClient | null }} clients
 * @returns {RuntimeClient}
 */
export function selectRuntimeClient(spec, clients) {
  const runtime = spec?.disk?.runtime;
  if (runtime === undefined) return clients.podman;
  if (runtime !== 'nspawn') throw new Error('Unknown environment runtime');
  if (!clients.nspawn) throw new Error('This environment runs on systemd-nspawn, which is unavailable');
  return clients.nspawn;
}
