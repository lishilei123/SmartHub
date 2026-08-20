---
name: test-case-design
description: Convert a frozen Requirement Release, clarification context, workspace, and historical library into executable multi-scenario test-case candidates. Use only in the test_case_design Stage.
---

# Test case design

1. Read the formal Requirement Release completely, relevant clarification/test-focus context, and `agent_workspace/planning_agent/historical-test-cases.json` when present. Use only its frozen Case IDs and Revisions.
2. For every in-scope Requirement, actively expand scenarios across role, permission, state, precondition, input equivalence class, boundary, normal/exception path, operation path, expected result, cleanup, and UI/API differences. One Requirement may produce many cases; never use a mechanical 1:1 mapping.
3. Every case must include one or more direct `requirementRefs` from the frozen Requirement Release. A case may cover multiple closely related Requirements. Use temporary case `ref` values. Submit each `cases[]` item as a flat `test-case/v2` object: `ref`, `schemaVersion`, `title`, `requirementRefs`, and `executionSpec` are sibling fields. Never use a `{ ref, content: {...} }` wrapper. Dependencies and `dataRequirements[].caseRefs` must use those refs; leave `dataRequirementIds` empty because the server owns formal relationships.
4. Emit `test-case/v2` and one dimension-specific `executionSpec` per case. Functional/security use `kind=functional` with UI or API steps/checks/preconditions/data/readiness/hint. Performance uses `method=performance_tool`; stability uses `method=long_running`; compatibility uses `method=environment_matrix` with a UI/API base method.
5. Performance thresholds must carry a released requirement or confirmed project-config `sourceRef`. Missing thresholds, stability duration/recovery criteria, or compatibility matrix must use null/empty values with `needs_confirmation` and create a blocking Confirmation Item. Never invent endpoints, selectors, credentials, accounts, test data, thresholds, durations, browsers, systems, viewports, versions, or environment values.
6. Produce one complete `proposals` list and cover every candidate case. Use `reuse` when frozen content remains valid, `update` only for actually affected cases while preserving source Case ID, `create` only when no historical case can cover the Requirement scenarios, `deprecate` for no-longer-applicable cases, and `reference` for design context excluded from this release. Include source Case ID/Revision when required, candidate ref when required, requirement refs, reason, and calibrated confidence.
7. Follow the invariant: reuse does not copy, update does not replace the Case ID, create alone receives a new Case ID, and removal is deprecation. You propose semantics only; never allocate IDs/Revisions/Hashes or modify the formal library.
8. Define data needs separately with constraints, quantity, state, isolation, sensitivity, cleanup, readiness, case refs, and Requirement refs. Never include production secrets or personal data.
9. Self-review for uncovered Requirements, shallow semantic coverage, proposal completeness, invalid frozen sources, duplicates, over-aggregation, dimension/spec mismatch, dependency cycles, execution readiness, and test-data readiness before submitting one complete candidate.

Do not create formal TestCase IDs, revisions, versions, hashes, publications, database updates, or Workspace writes. This Skill cannot change Workflow Stage.
