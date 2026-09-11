import { createHash } from 'node:crypto';

// Keep the Node toolchain on the same distribution as systemd and Chromium.
// `systemd-networkd` is installed by the systemd package but ships disabled, and a machine given a
// virtual ethernet has nothing else to configure its `host0`: the interface stays down, so the host side
// of the pair stays without carrier and the machine has no network at all. Enabling it is the one service
// the runtime depends on; nothing else general-purpose belongs in a development image. The resolver needs
// nothing here — `systemd-resolved` is not installed and the image already carries a static resolver.
// Both registry inputs are pinned; distro security updates are resolved when the recipe is built.
export const PROJECT_CONTAINERFILE = `FROM docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ENV container=podman
COPY --from=docker.io/library/node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e /usr/local /usr/local
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus ca-certificates curl iproute2 procps less \\
      git openssh-client python3 bash tar util-linux ripgrep \\
      chromium fonts-liberation poppler-utils \\
      libreoffice-writer libreoffice-calc libreoffice-impress \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /workspace /data /run/elowen \\
 && systemctl mask systemd-remount-fs.service getty.target \\
 && systemctl enable systemd-networkd.service systemd-networkd.socket
WORKDIR /workspace
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
`;

/** The tag IS the recipe: changing a single package changes the hash and therefore the image a NEW
 *  environment is created from. That is deliberate, and so is what it does not do. A project's image is
 *  stamped into its stored specification once, when its row is first created, and every later start reads
 *  it from there — so an environment already bound to an older recipe keeps running and restarting on the
 *  image it was built with. A new tag never replaces a container underneath a running project, and it is
 *  never built for one either: the build step only fires when the stored image matches the current tag. */
export const PROJECT_BASE_IMAGE_TAG = `localhost/elowen-project-base:${createHash('sha256').update(PROJECT_CONTAINERFILE).digest('hex').slice(0, 16)}`;
