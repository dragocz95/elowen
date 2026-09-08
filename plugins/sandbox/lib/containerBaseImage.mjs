import { createHash } from 'node:crypto';

// Keep the Node toolchain on the same distribution as systemd and Chromium.
// Both registry inputs are pinned; distro security updates are resolved when the recipe is built.
export const PROJECT_CONTAINERFILE = `FROM docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ENV container=podman
COPY --from=docker.io/library/node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e /usr/local /usr/local
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus ca-certificates curl iproute2 procps less \\
      git openssh-client python3 bash tar util-linux ripgrep \\
      chromium fonts-liberation \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /workspace /data /run/elowen \\
 && systemctl mask systemd-remount-fs.service getty.target
WORKDIR /workspace
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
`;

export const PROJECT_BASE_IMAGE_TAG = `localhost/elowen-project-base:${createHash('sha256').update(PROJECT_CONTAINERFILE).digest('hex').slice(0, 16)}`;
