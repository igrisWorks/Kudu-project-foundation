---
name: AppImage sandbox defaults
description: Electron Builder AppImage launchers can alter Chromium sandbox behavior.
---

**Rule:** Do not rely on Electron Builder's default AppRun sandbox fallback. Keep the generated launcher fail-closed: reject root and `--no-sandbox`, and exit when unprivileged user namespaces are unavailable.

**Why:** Electron Builder's upstream AppRun template adds `--no-sandbox` when its user-namespace probe fails. A main-process guard prevents windows from opening, but patching the launcher avoids passing that flag at all.

**How to apply:** Keep the version-pinned builder patch and prerequisite-check assertion in sync. After changing the builder version or AppImage target, inspect extracted AppRun and test root, explicit-flag, and missing-namespace refusals.
