---
name: Editable team allocation baselines
description: Persistence and safety rules for annual team allocations, visibility, adjustments, and upstream limits.
---

Annual team allocation baselines and visibility are administrator-owned persistent settings. Baseline initialization may add missing canonical teams, but must never overwrite an existing team’s allocation or hidden state. Every administrator change requires an atomic audit record.

**Why:** Restart-time initialization previously restored spreadsheet defaults, which silently erased administrator decisions. Approved Finance adjustments are a separate durable source and must continue to add on top of the editable baseline.

**How to apply:** Treat the saved baseline plus accepted adjustments as the effective annual allocation. Recalculate derived monthly limits from that effective total, but keep reconciliation read-only and require a separate explicit action for upstream writes.