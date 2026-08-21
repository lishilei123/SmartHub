---
name: test-design-repair
description: Apply a lightweight TestCase v3 patch for deterministic Coverage blockers. Use only in test_design_repair.
---

# Test design repair

1. Read `current-test-cases.json`, the frozen Requirement Release, the selected `agent_repair` blockers, and the exact `baseCandidateSha256`.
2. Submit only `test-design-repair/v3`: `schemaVersion`, `baseCandidateSha256`, complete flat `upsertCases`, and `removeCaseRefs`. Do not submit a complete Candidate or any ScenarioClaim, dimension assessment, execution specification, data requirement, Finding, Confirmation, or Proposal.
3. Preserve unrelated Cases and stable refs. If a Requirement lacks direct coverage, add a Case that actually verifies that Requirement; do not relabel an existing risk-exploration Case with an unrelated `requirementRefs` value.
4. Remove only a current Candidate Delta item that is genuinely invalid or redundant. `removeCaseRefs` never removes or deprecates a Historical Baseline Case; removing a Candidate update means the Service falls back to the unchanged frozen historical Revision.
5. Preserve the v3 fact boundary: no invented business rule, threshold, interface, URL, selector, credential, environment, error, or state behavior. If the base Hash is stale, reread the current Candidate instead of guessing.

The Service reapplies the full v3 Validator and Coverage Audit and owns formal state.
