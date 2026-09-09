import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PROJECT_BASE_IMAGE_TAG, PROJECT_CONTAINERFILE } from '../../plugins/sandbox/lib/containerBaseImage.mjs';

/** Guest-side consumers of the managed Project environment resolve tools through the guest's own PATH
 * (`/usr/bin/env --`), so the canonical image itself must carry Node.js/npm (built-in LSP servers and
 * npm-driven project tooling) and Chromium (built-in browser). These tests pin the recipe contract:
 * supported Node LTS and distro Chromium are installed inside the image, every foundational
 * dependency of the original recipe is retained, and the recipe tag stays content-addressed. */

const NODE_PIN = /COPY --from=docker\.io\/library\/node:24-bookworm-slim@sha256:[a-f0-9]{64} \/usr\/local \/usr\/local/;
const BASE_PIN = /FROM docker\.io\/library\/debian:bookworm-slim@sha256:[a-f0-9]{64}\n/;

describe('project base image prerequisites', () => {
  it('ships the supported Node.js 24 LTS runtime and bundled npm on the guest PATH', () => {
    const match = PROJECT_CONTAINERFILE.match(NODE_PIN);
    expect(match, 'the official Node.js 24 bookworm-slim image must be pinned by digest').not.toBeNull();
    // /usr/local/bin is a default PATH member in every guest shell and transient unit, so `node`,
    // `npm` and `npx` resolve inside the container without any PATH surgery.
    expect(match![0].endsWith('/usr/local /usr/local')).toBe(true);
  });

  it('installs the distro Chromium package instead of host or downloaded binaries', () => {
    const install = PROJECT_CONTAINERFILE.match(/apt-get install -y --no-install-recommends \\([\s\S]*?)\\\n\s*&& apt-get clean/);
    expect(install).not.toBeNull();
    const packages = install![1]!;
    expect(packages).toContain('chromium');
    // Headless browsing renders text; the distro font package keeps screenshots legible.
    expect(packages).toContain('fonts-liberation');
    // Grep resolves ripgrep through the guest PATH, so an image without it fails the tool on every
    // managed project — which is how this was found: from the real tool, not from a stand-in provider.
    expect(packages).toContain('ripgrep');
    // The editor's office preview converts docx/xlsx/pptx with `soffice` inside the guest; without the
    // three distro components the managed preview can only answer 501.
    for (const component of ['libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress']) expect(packages).toContain(component);
    // No arbitrary install scripts, no tarballs, no host paths for either toolchain.
    expect(PROJECT_CONTAINERFILE).not.toMatch(/nodesource|setup_\d+\.x|nodejs\.org|\bcurl\s+[^\\]*\|\s*(ba)?sh|\/var\/www|workspace\/\.\./i);
  });

  it('retains the foundational image contract of the original recipe', () => {
    expect(PROJECT_CONTAINERFILE).toMatch(BASE_PIN);
    expect(PROJECT_CONTAINERFILE).toContain('ENV container=podman');
    expect(PROJECT_CONTAINERFILE).toContain('systemd systemd-sysv');
    expect(PROJECT_CONTAINERFILE).toContain('git openssh-client python3');
    expect(PROJECT_CONTAINERFILE).toContain('mkdir -p /workspace /data /run/elowen');
    expect(PROJECT_CONTAINERFILE).toContain('systemctl mask systemd-remount-fs.service getty.target');
    expect(PROJECT_CONTAINERFILE).toContain('STOPSIGNAL SIGRTMIN+3');
    expect(PROJECT_CONTAINERFILE).toContain('ENTRYPOINT ["/sbin/init"]');
    expect(PROJECT_CONTAINERFILE).toContain('apt-get clean');
    expect(PROJECT_CONTAINERFILE).toContain('rm -rf /var/lib/apt/lists/*');
  });

  it('keeps the recipe tag content-addressed and sensitive to recipe changes', () => {
    expect(PROJECT_BASE_IMAGE_TAG).toBe(`localhost/elowen-project-base:${createHash('sha256').update(PROJECT_CONTAINERFILE).digest('hex').slice(0, 16)}`);
    // The scheme itself reacts to any recipe edit, so toolchain bumps get a fresh identity.
    expect(createHash('sha256').update(`${PROJECT_CONTAINERFILE}\n`).digest('hex').slice(0, 16)).not.toBe(PROJECT_BASE_IMAGE_TAG.split(':')[1]);
  });
});