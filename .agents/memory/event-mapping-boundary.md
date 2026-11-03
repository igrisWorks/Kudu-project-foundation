---
name: Opt-in event mapping
description: The boundary between explicit source mappings and legacy file-import behavior.
---

Active mappings are the opt-in boundary for alternate CSV/JSON source shapes, including nested JSON record paths. Without an active mapping, keep the established parser requirements and event/payload behavior unchanged.

Discovery must be a deliberate operator action, separate from source registration, editing, and enablement. Suggestions may create or update a draft, but only the explicit validation and activation flow may make a mapping active.

**Why:** Explicit field renaming cannot work if the default parser rejects the source headers first, while relaxing the parser globally would silently change existing imports. The user also requires that saving or enabling a source never causes external requests or reads.

**How to apply:** When changing import parsing or normalization, branch on the active mapping and test both a mapped noncanonical source and an unmapped legacy source. Keep discovery and activation as separate, user-triggered steps.
