---
name: failure-analysis
description: Classify repeated execution failures from immutable attempts and artifacts. Use only in the failure_diagnosis Stage.
---

# Failure analysis

1. Read the frozen task, current ScriptRevision, one or more terminal attempts, current Binding and only the artifact metadata or excerpts supplied in the read-only workspace.
2. Distinguish product behavior, script implementation, selector drift, environment, test data, flakiness, assertion mismatch, timeout, and unknown causes. Do not infer a root cause without cited observations.
3. Evidence must reference only the current task's immutable terminal attempts and supplied artifacts. Never cite a running attempt or external fact.
4. Mark repairable only when the evidence supports `script_defect` or `selector_changed`. Do not mark `product_defect`, `assertion_mismatch`, or `unknown` as automatically repairable.
5. Do not propose changing the formal TestCase, Expected Result, verification semantics, assertion meaning, test objective, or requirement rules.
6. Submit one `failure-analysis/v1` candidate. The service validates scope, provenance, category, evidence, and the deterministic repair policy.

This Skill cannot execute code, invoke Runner or another Agent, access shell, network, database, or change workflow state.
