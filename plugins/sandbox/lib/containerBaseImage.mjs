import { createHash } from 'node:crypto';

// Same pinned distribution as Sites; projects additionally need real Git and document/script tooling.
export const PROJECT_CONTAINERFILE = `FROM docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
ENV container=podman
RUN apt-get update \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
      systemd systemd-sysv dbus ca-certificates curl iproute2 procps less \\
      git openssh-client python3 bash tar util-linux \\
 && apt-get clean \\
 && rm -rf /var/lib/apt/lists/* \\
 && mkdir -p /workspace /data /run/elowen \\
 && systemctl mask systemd-remount-fs.service getty.target
WORKDIR /workspace
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
`;

export const PROJECT_BASE_IMAGE_TAG = `localhost/elowen-project-base:${createHash('sha256').update(PROJECT_CONTAINERFILE).digest('hex').slice(0, 16)}`;
