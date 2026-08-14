---
name: test-case-design
description: Convert an approved immutable TestPointTreeVersion and frozen historical library into executable candidates, dimension-specific execution specs, and complete change proposals. Use only in the test_case_design Stage.
---

# Test case design

1. Read the approved `test-design/test-point-tree.json`, relevant requirements, and `agent_workspace/planning_agent/historical-test-cases.json` when present. Use only its frozen Case IDs and Revisions.
2. Cover every applicable executable leaf test point. Split cases when role, precondition, state, input partition or boundary, action, expected outcome, cleanup, or execution lifecycle differs.
3. Use temporary case `ref` values. Dependencies and `dataRequirements[].caseRefs` must use those refs; leave `dataRequirementIds` empty because the server owns formal relationships.
4. Emit `test-case/v2` and one dimension-specific `executionSpec` per case. Functional/security use `kind=functional` with UI or API steps/checks/preconditions/data/readiness/hint. Performance uses `method=performance_tool`; stability uses `method=long_running`; compatibility uses `method=environment_matrix` with a UI/API base method.
5. Performance thresholds must carry a released requirement or confirmed project-config `sourceRef`. Missing thresholds, stability duration/recovery criteria, or compatibility matrix must use null/empty values with `needs_confirmation` and create a blocking Confirmation Item. Never invent endpoints, selectors, credentials, accounts, test data, thresholds, durations, browsers, systems, viewports, versions, or environment values.
6. Produce one complete `proposals` list and cover every candidate case. Use `reuse` when frozen content remains valid, `update` only for actually affected cases while preserving source Case ID, `create` only when no historical case can cover the test points, `deprecate` for no-longer-applicable cases, and `reference` for design context excluded from this release. Include source Case ID/Revision when required, candidate ref when required, requirement refs, test-point IDs, reason, and calibrated confidence.
7. Follow the invariant: reuse does not copy, update does not replace the Case ID, create alone receives a new Case ID, and removal is deprecation. You propose semantics only; never allocate IDs/Revisions/Hashes or modify the formal library.
8. Define data needs separately with constraints, quantity, state, isolation, sensitivity, cleanup, readiness, case refs, and test-point refs. Never include production secrets or personal data.
9. Self-review for uncovered points, proposal completeness, invalid frozen sources, duplicates, over-aggregation, dimension/spec mismatch, dependency cycles, execution readiness, and test-data readiness before submitting one complete candidate.

Do not create formal TestCase IDs, revisions, versions, hashes, publications, database updates, or Workspace writes. This Skill cannot change Workflow Stage.
