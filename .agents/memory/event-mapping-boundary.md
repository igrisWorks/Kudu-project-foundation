---
name: Opt-in event mapping
description: The boundary between explicit source mappings and legacy file-import behavior.
---

Active mappings are the opt-in boundary for alternate CSV/JSON source shapes. Without an active mapping, keep the established parser requirements and event/payload behavior unchanged.

**Why:** Explicit field renaming cannot work if the default parser rejects the source headers first, while relaxing the parser globally would silently change existing imports.

**How to apply:** When changing import parsing or normalization, branch on the active mapping and test both a mapped noncanonical source and an unmapped legacy source.
