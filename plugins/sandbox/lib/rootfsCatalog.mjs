import { createHash } from 'node:crypto';

/** The root filesystems this release can build an environment from, and where its copies live.
 *
 *  The machine runtime has no image store and never builds a root filesystem on the host it serves.
 *  Producing one means running a package manager against a distribution mirror: minutes of work, a
 *  different result on a different day, and a failure mode that lands on whoever happened to create the
 *  next environment. So a root filesystem is BUILT once in the release pipeline and SHIPPED as a tarball
 *  that every host downloads and verifies by digest.
 *
 *  That makes the digest the artifact's identity. `<name>@<version>` names a recipe and the revision of
 *  it; the digest is the exact bytes, pinned here. A host that fetches something whose digest differs has
 *  fetched something else, and says so rather than unpacking it.
 *
 *  `version` is the recipe revision and is bumped by hand whenever `recipe` below changes. It is not
 *  derived from the recipe's content hash, which is what the container tags did: a derived tag changes
 *  silently with every edit, and an environment already built from the old one then refers to a name
 *  nothing in the catalogue answers for. A hand-set integer forces the person changing a recipe to say
 *  which artifacts they are producing, and leaves every earlier one still nameable. */

/** Where published artifacts live. GitHub Releases on the repository that already exists, because the
 *  only alternatives were new infrastructure: the npm package would carry hundreds of megabytes into
 *  every install, and a dedicated host would need credentials this project does not have. Publishing
 *  reuses the owner-only release authority; downloading needs no credential at all, which is why the
 *  daemon can do it and why nothing here handles a secret. */
export const ARTIFACT_BASE_URL = 'https://github.com/dragocz95/elowen/releases/download';

/** An instance may serve artifacts from its own mirror instead — an air-gapped host, or one that will not
 *  reach GitHub. The override is an operator setting and is held to the same digest, so a mirror can
 *  change where the bytes come from and not what they are. */
export const ARTIFACT_MIRROR_SETTING = 'rootfsArtifactBaseUrl';

/** No artifact may be larger than this. It bounds the download, the disk it lands on, and the damage a
 *  redirected or replaced URL can do before the digest is ever checked. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;

/** What each artifact is, in the form the build script consumes. `packages` is the exact apt set;
 *  `suite` and `mirror` pin the distribution. Nothing here is read at runtime — the daemon only ever
 *  reads `artifacts` below — but it lives beside the pins so that changing a recipe without bumping its
 *  version is visible in one diff. */
export const ROOTFS_RECIPES = Object.freeze({
  'project-base': Object.freeze({
    version: 1,
    suite: 'bookworm',
    variant: 'important',
    // The same set the container recipe carried, minus what only a container runtime needed. systemd is
    // the guest's init; systemd-networkd is enabled because a machine given a virtual ethernet has
    // nothing else to configure its `host0`, and without it the interface never comes up.
    packages: Object.freeze([
      'systemd', 'systemd-sysv', 'dbus', 'ca-certificates', 'curl', 'iproute2', 'procps', 'less',
      'git', 'openssh-client', 'python3', 'bash', 'tar', 'util-linux', 'ripgrep',
      'chromium', 'fonts-liberation', 'poppler-utils',
      'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress',
    ]),
    // Node is not in Debian at the version this project needs, so the build unpacks the official
    // tarball. Its checksum is not written here: Node publishes a signed SHASUMS256.txt per release and
    // the build verifies against that, then records what it actually used in the artifact's provenance.
    // A checksum copied into this file by hand is one nobody re-derives and everybody trusts.
    node: Object.freeze({ version: '24.8.0' }),
    masked: Object.freeze(['systemd-remount-fs.service', 'getty.target']),
    enabled: Object.freeze(['systemd-networkd.service', 'systemd-networkd.socket']),
    directories: Object.freeze(['/workspace', '/data', '/run/elowen']),
  }),
  'site-base': Object.freeze({
    version: 1,
    suite: 'bookworm',
    variant: 'important',
    packages: Object.freeze(['systemd', 'systemd-sysv', 'dbus', 'ca-certificates', 'curl', 'iproute2', 'procps', 'tar', 'util-linux']),
    masked: Object.freeze(['systemd-remount-fs.service', 'getty.target']),
    enabled: Object.freeze(['systemd-networkd.service', 'systemd-networkd.socket']),
    directories: Object.freeze(['/workspace', '/data', '/run/elowen']),
  }),
  'site-static': Object.freeze({
    version: 1,
    base: 'site-base',
    packages: Object.freeze(['nginx-light']),
  }),
  'site-node': Object.freeze({
    version: 1,
    base: 'site-base',
    packages: Object.freeze([]),
    node: Object.freeze({ version: '24.8.0' }),
  }),
});

/** Which artifact serves which fixed Sites recipe. The Sites plugin decides which KIND a Site runs on;
 *  which bytes that kind means is this runtime's to know, because this runtime is what unpacks them. */
export const SITE_ARTIFACTS = Object.freeze({ base: 'site-base', static: 'site-static', node: 'site-node' });

/** The project artifact every new managed Project is built from. */
export const PROJECT_ARTIFACT = 'project-base';

/** The pinned copies. `digest` is `sha256:` and 64 hex characters; `sizeBytes` is the exact published
 *  length; `path` is appended to the base URL.
 *
 *  An entry whose `digest` is null is a recipe this release DECLARES but has not published. That is a
 *  real state and it is spelled out rather than hidden: the artifact store refuses it with an
 *  unpublished error naming the reference, readiness reports it as a separate unmet row, and nothing
 *  falls back to building one on the host. The release script fills these in and the contract test holds
 *  the file to its own shape. */
export const ROOTFS_ARTIFACTS = Object.freeze({
  'project-base@1': Object.freeze({ digest: null, sizeBytes: null, path: 'rootfs-project-base-v1/project-base-v1.tar.zst' }),
  'site-base@1': Object.freeze({ digest: null, sizeBytes: null, path: 'rootfs-site-base-v1/site-base-v1.tar.zst' }),
  'site-static@1': Object.freeze({ digest: null, sizeBytes: null, path: 'rootfs-site-static-v1/site-static-v1.tar.zst' }),
  'site-node@1': Object.freeze({ digest: null, sizeBytes: null, path: 'rootfs-site-node-v1/site-node-v1.tar.zst' }),
});

const REFERENCE = /^([a-z][a-z0-9-]{0,40})@([1-9][0-9]{0,8})$/;
export const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;

/** `<name>@<version>` for a recipe this release knows. A name it does not know is refused here rather
 *  than turned into a URL. */
export function artifactReference(name) {
  const recipe = Object.hasOwn(ROOTFS_RECIPES, name) ? ROOTFS_RECIPES[name] : null;
  if (!recipe) throw Object.assign(new Error(`Unknown root filesystem recipe: ${name}`), { code: 'artifact_unknown' });
  return `${name}@${recipe.version}`;
}

export function parseArtifactReference(reference) {
  const match = typeof reference === 'string' ? REFERENCE.exec(reference) : null;
  if (!match) throw Object.assign(new Error('Invalid root filesystem artifact reference'), { code: 'artifact_unknown' });
  return { name: match[1], version: Number(match[2]) };
}

/** The pinned entry for a reference, or null when this release does not carry one. A reference that
 *  parses but names a version this release never published is the ordinary case after an artifact is
 *  revised, and a disk built from it keeps its provenance readable even though nothing can fetch it
 *  again — which is exactly why materialization must not depend on the artifact surviving. */
export function artifactEntry(reference) {
  parseArtifactReference(reference);
  const entry = Object.hasOwn(ROOTFS_ARTIFACTS, reference) ? ROOTFS_ARTIFACTS[reference] : null;
  return entry ? { reference, ...entry } : null;
}

/** Every reference this release expects to be able to fetch. */
export const knownReferences = () => Object.keys(ROOTFS_ARTIFACTS);

/** The blob's file name in the content-addressed store. Derived from the digest alone, so two recipes
 *  that happen to produce identical bytes share one copy and neither owns it. */
export function blobName(digest) {
  if (!ARTIFACT_DIGEST.test(digest ?? '')) throw Object.assign(new Error('Invalid artifact digest'), { code: 'artifact_digest_invalid' });
  return `${digest.replace(':', '-')}.tar.zst`;
}

/** A stable fingerprint of the recipe set, so the release script and the contract test can agree that a
 *  recipe changed without either of them re-deriving what changed. */
export function recipeDigest(name) {
  const recipe = Object.hasOwn(ROOTFS_RECIPES, name) ? ROOTFS_RECIPES[name] : null;
  if (!recipe) throw Object.assign(new Error(`Unknown root filesystem recipe: ${name}`), { code: 'artifact_unknown' });
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}
