---
name: Group spend display model
description: Project accounting on the dashboard versus member visibility and legacy alert accounting.
---

# Group spend display model

## The rule

Dashboard group, team, and enterprise totals use project attribution, with each project counted once. A project seen in the primary Comcast workspace and a sub-workspace belongs to the sub-workspace; otherwise highest reported project spend wins.

Member and cluster drill-down pages continue to show per-person usage. Existing group/team threshold alerts intentionally continue to use their legacy raw/member accounting until alert behavior is separately migrated.

Project-level spend without a usable project ID is shown as an enterprise-level unattributed line so the dashboard rows reconcile to the enterprise total.

**Why:**
Member totals can double-count people in multiple groups and omit spend from deleted accounts. Project totals provide stable chargeback, while member drill-downs still need complete individual visibility. Changing alerts simultaneously would alter established threshold behavior before the new model is proven.

**How to apply:**
Use project-attributed values for dashboard spend, remaining budget, usage percentage, team headers, and enterprise summary. Keep member usage for drill-down member rows and historical trends, and do not silently switch alert thresholds to project totals.
