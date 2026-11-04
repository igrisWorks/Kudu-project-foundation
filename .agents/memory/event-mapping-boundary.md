---
name: Opt-in event mapping
description: The boundary between explicit source mappings and legacy file-import behavior.
---

Active mappings are the opt-in boundary for alternate CSV/JSON source shapes, including nested JSON record paths. Without an active mapping, keep the established parser requirements and event/payload behavior unchanged.

Discovery must be a deliberate operator action, separate from source registration, editing, and enablement. Suggestions may create or update a draft, but only the explicit validation and activation flow may make a mapping active.

Ingestion deduplication fingerprints must not include per-run lineage metadata such as a sync-run ID. Keep run and mapping lineage in stored provenance, while comparing normalized event content so an identical replay is a duplicate and changed content under a stable source ID remains a conflict.

Keep industrial recognition vendor-independent across the shared REST/JSON/CSV path. Semantic fields outside the canonical event contract belong in the existing payload. Preselect only high-confidence suggestions with adequate sample evidence; leave low-confidence and ambiguous suggestions unselected. Inspect nested structures without flattening array members or inventing field meanings.

**Why:** Explicit field renaming cannot work if the default parser rejects the source headers first, while relaxing the parser globally would silently change existing imports. The user requires vendor-independent recognition, intact original structures, and explicit operator control; saving or enabling a source must not cause external requests or reads.

**How to apply:** When changing import parsing or normalization, branch on the active mapping and test REST, JSON, and CSV through shared discovery and normalization, plus an unmapped legacy source. Keep discovery, validation, activation, and import/sync user-triggered. Do not flatten nested array members. When adding import lineage, verify that changing only the run ID does not turn a replay into a conflict.
