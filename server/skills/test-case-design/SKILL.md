---
name: test-case-design
description: Design concise TestCase v3 semantics from a frozen Requirement Release and relevant risk context. Use only in test_case_design.
---

# Test case design

1. Treat Runtime-provided `requirementRelease.content` as the complete frozen Requirement Release and primary business-fact source. Read only relevant user material, Knowledge, defect history, and the explicitly frozen historical snapshot from `/workspace`.
2. Requirement defines product facts but does not bound the test space. First cover core Requirement behavior directly, then actively explore valuable normal, exception, boundary, state, permission, concurrency, idempotency, recovery, consistency, performance, stability, compatibility, security, historical-defect, and Knowledge-derived risk scenarios.
3. `requirementRefs` is direct traceability only. When the expected behavior comes directly from a Requirement, include its real ID. For legitimate risk exploration without a direct Requirement behavior basis, submit `requirementRefs: []`. Never attach an unrelated Requirement merely to increase Coverage.
4. Exploration does not authorize invented business rules. Do not invent limits, thresholds, permissions, state machines, error codes, messages, interfaces, URLs, selectors, accounts, credentials, environments, or data. When concrete behavior is unknown, assert only defensible safety, stability, consistency, authorization, and recoverability baselines, or defer technical facts to TestExecution.
5. Consider functional, performance, stability, compatibility, and security as thinking directions, not Schema gates. Generate only valuable cases; do not pad every dimension or submit applicability explanations.
6. A Case should have a clear, reviewable test objective. Keep a natural business loop together when its steps jointly prove one outcome; split behaviors that can fail independently and represent clearly different intents. This is guidance, not a deterministic atomicity rule.
7. A Case has one natural-language `preconditions`, `steps`, and `expectedResults` set. `executionMethods` is exactly `ui`, `api`, or both. Do not submit separate UI/API steps or any selector, endpoint, automation, readiness, data-governance, Coverage, Finding, Confirmation, or Proposal fields.
8. Submit `test-case-design/v3` with root fields `schemaVersion` and `cases` only. Every flat Case contains exactly `ref`, `schemaVersion=test-case/v3`, `title`, `dimension`, `priority`, `requirementRefs`, `executionMethods`, `preconditions`, `steps`, and `expectedResults`.
9. Treat `cases[]` as the current Candidate Delta, never as the complete library. If `historical-test-cases.json` exists, read it only as needed to understand existing coverage and affected scenarios. Submit only new or genuinely changed cases; do not resubmit unchanged history and do not emit reuse/update/create/deprecate lifecycle actions. `cases: []` is valid when no historical scenario needs a change.
10. Omission is not deletion. Any frozen historical Case absent from the Candidate remains in the effective set; only the Service matches intersections and owns formal lifecycle decisions.
11. Historical `requirementRefs` belong to the source Requirement Release. Use them only to understand historical intent; never assume that the same `RP-xxx` identifies the same Requirement in the current Release. Submit direct trace only with IDs from the Runtime-provided current Requirement Release. Cross-release mapping is exclusively Service-owned.
12. Self-review that direct Requirement coverage is explicit, extended cases are not falsely traced, expected results contain no fabricated product rule, refs are unique, and every submitted Case has steps, expected results, and at least one UI/API execution method.

The Service owns formal IDs, revisions, hashes, history matching, review, publication, traceability persistence, and Workspace projection. This Skill cannot change Workflow state.
