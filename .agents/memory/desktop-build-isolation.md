---
name: Desktop dependency isolation
description: Keep Electron tooling out of the existing web/backend Docker workspace.
---

**Rule:** Keep Electron and Electron Builder in a nested desktop pnpm package with its own lockfile. Orchestrate it from root scripts rather than adding desktop tools to root dev dependencies or modifying Docker/Compose to filter them.

**Why:** The root Docker build installs the whole root workspace; root-level Electron dependencies would pull the desktop runtime and packaging toolchain into the server build.

**How to apply:** For Kudu desktop work, keep the desktop package outside the root workspace globs and preserve the existing Dockerfile and Compose configuration.
