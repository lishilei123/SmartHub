---
name: test-case-design
description: Convert an approved immutable TestPointTreeVersion into executable UI and API test case and test-data candidates. Use only in the test_case_design Stage.
---

# Test case design

1. Read the approved `test_design/test-point-tree.json`, relevant requirements, and required API, UI, environment, or historical material.
2. Cover every applicable executable leaf test point. Split cases when role, precondition, state, input partition or boundary, action, expected outcome, cleanup, or execution lifecycle differs.
3. Use temporary case `ref` values. Dependencies and `dataRequirements[].caseRefs` must use those refs; leave `dataRequirementIds` empty because the server owns formal relationships.
4. For UI, provide a concrete entry, ordered steps with step-level expected results, verification checks, readiness, and automation hint. For API, provide method/path, known schema refs, ordered steps, checks, readiness, and automation hint.
5. Mark blocked or confirmation-dependent execution honestly. Never invent endpoints, selectors, credentials, test data, timeouts, or environment values.
6. Define data needs separately with constraints, quantity, state, isolation, sensitivity, cleanup, readiness, case refs, and test-point refs. Never include production secrets or personal data.
7. Self-review for uncovered points, invalid references, duplicates, over-aggregation, dimension mismatch, dependency cycles, UI/API readiness, and test-data readiness before submitting one complete candidate.

Do not create formal TestCase IDs, revisions, versions, hashes, publications, database updates, or Workspace writes. This Skill cannot change Workflow Stage.
