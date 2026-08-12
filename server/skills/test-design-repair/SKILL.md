---
name: test-design-repair
description: Repair complete test-case candidates only for deterministic Coverage Audit blockers marked resolution=agent_repair. Use only in the test_design_repair Stage.
---

# Test design repair

1. Read `agent_workspace/design_agent/current-test-cases.json`, the approved test-point tree, and server-provided Audit blockers.
2. Repair only blockers whose `resolution` is `agent_repair`, such as an uncovered test point, duplicate or over-aggregated case, or invalid test-point reference.
3. Preserve unrelated correct cases and stable temporary refs. Return a complete re-auditable candidate, not a partial patch.
4. Do not resolve `human_decision`, `manual_edit`, or business-policy gaps. Missing thresholds, browser matrices, permissions, timeout rules, or business decisions must remain Findings or Confirmation Items for people.
5. Recheck coverage, references, dimensions, UI/API readiness, data readiness, dependency cycles, duplicates, and aggregation before submitting.

The server controls the two-attempt limit, Audit execution, formal IDs, revisions, versions, hashes, publication, and Workspace projection. This Skill cannot change Stage or permissions.
