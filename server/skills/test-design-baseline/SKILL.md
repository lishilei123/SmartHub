---
name: test-design-baseline
description: Establish the immutable fact and risk baseline for PlanningAgent from a frozen ProjectVersion Workspace and bound Requirement Release before direct test-case design.
---

# Test design baseline

1. Treat the Runtime-provided `requirementRelease.content` as the complete frozen Requirement Release and primary source of truth. Use `/workspace` only for user-provided project material and explicitly listed historical snapshots.
2. Read the frozen `historical-test-cases.json` when present. It contains the selected project TestCaseLibraryVersion or historical suite with stable Case ID and Revision. Never replace that frozen selection with `latest` during a Run.
3. Read API, UI, environment, technical, defect, and shared Knowledge material only when relevant and available. Treat it as enhancement context, never as a replacement for a released requirement.
4. Build an internal map of business goals, actors, permissions, state transitions, inputs, outputs, interfaces, data effects, failure paths, and observable oracles. Also map requirement changes to frozen historical cases: still valid, affected, no longer applicable, reference-only, and uncovered. Do not emit a coverage-unit artifact.
5. Preserve facts with only basis or historical refs exposed by the frozen run. Historical Case ID and Revision may only be copied from that snapshot; do not invent formal IDs, versions, revisions, hashes, or evidence.
6. If a threshold, compatibility matrix, permission decision, timeout rule, or other business rule is absent, create a Confirmation Item. Never supply a plausible value from general knowledge.

This Skill provides methods only. It cannot change Stage, activate tools, write Workspace files, publish versions, or modify the database.
