# Clean "first unboxing" machine for the install smoke test. Node 22 matches CI
# (setup-node node-version: 22); the glibc base lets better-sqlite3 use its
# prebuilt binary. Deliberately NO C toolchain — node-pty is an optionalDependency
# and its build is expected to fail here, exercising the same graceful-degradation
# path a bare user machine hits. NO repo source is ever copied in: the ONLY thing
# installed is the packed tarball, exactly what `npm install -g elowen` ships.
FROM node:22-bookworm-slim

# docs/site/02-install.md requirements: tmux (agents run inside tmux); git is on any
# real dev box and cli-status detection may shell out to it.
RUN apt-get update && apt-get install -y --no-install-recommends tmux git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG ELOWEN_VERSION
ENV ELOWEN_EXPECTED_VERSION=${ELOWEN_VERSION}

# Install exactly what a new user installs: the published artifact, globally. Its
# runtime deps resolve from the public registry on purpose — a mis-pinned dep that
# breaks a fresh install is one of the bugs this test exists to catch.
COPY elowen.tgz /tmp/elowen.tgz
RUN npm install -g --no-audit --no-fund /tmp/elowen.tgz && rm /tmp/elowen.tgz

# Unbox as a normal non-root user — the launcher/daemon create ~/.config/elowen.
RUN useradd -m -s /bin/bash newuser
USER newuser
WORKDIR /home/newuser

COPY --chown=newuser:newuser smoke.mjs /home/newuser/smoke.mjs
CMD ["node", "/home/newuser/smoke.mjs"]
