---
name: AppImage sandbox defaults
description: Electron Builder AppImage launchers can alter Chromium sandbox behavior.
---

**Rule:** Do not assume Electron window-level sandbox settings protect a Linux AppImage. Inspect the generated desktop entry and AppRun behavior, keep launcher arguments from explicitly disabling the sandbox, and refuse startup when sandbox prerequisites are absent.

**Why:** The AppImage launcher can add `--no-sandbox` as a fallback when unprivileged user namespaces are unavailable; that process-wide flag overrides the intended renderer security boundary.

**How to apply:** After changing the Electron Builder version or AppImage target, inspect the extracted AppImage metadata and test its fail-closed path before treating the package as runtime-ready.
