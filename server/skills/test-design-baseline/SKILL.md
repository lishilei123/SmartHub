---
name: test-design-baseline
description: Establish the immutable fact and risk baseline for PlanningAgent before TestCase v3 design.
---

# Test design baseline

1. Treat Runtime-provided `requirementRelease.content` as the complete frozen Requirement Release and primary source of business truth. Use `/workspace` only for user-provided project material and explicitly listed historical snapshots.
2. Read `historical-test-cases.json` when present. It is immutable context for semantic comparison, not an AI Proposal protocol; never invent or overwrite Case IDs, revisions, hashes, or library history.
3. Read relevant API, UI, environment, technical, defect, and Knowledge material only as context. Execution facts help a later ExecutionImplementationAgent; they do not belong in TestCase v3.
4. Internally map business goals, actors, permissions, states, inputs, outputs, data effects, failures, observable behavior, and risk surfaces. Do not emit a separate coverage or reasoning artifact.
5. Distinguish direct Requirement behavior from test-engineering exploration. Extended risk cases may have `requirementRefs: []`; Knowledge and history may suggest risks but cannot create product facts.
6. Never invent a threshold, matrix, permission, timeout, interface, locator, account, environment, error, or state rule. Keep unknown implementation facts for TestExecution configuration.

This Skill supplies methods only and cannot change Stage, tools, Workspace, publication, or database state.
