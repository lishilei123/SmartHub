---
name: test-point-design
description: Design a complete Test Point Tree candidate directly from the frozen requirement baseline and optional Workspace context. Use only in the test_point_design Stage.
---

# Test point design

Design the tree at independently testable behavior and risk granularity.

- Functional: cover primary flows, branches, exceptions, interruption and recovery, state transitions, roles and permissions, equivalence classes, boundary values, data constraints, API behavior, idempotency, concurrency, and cross-system consistency. Separate UI/API entry from execution scope and test dimension.
- Performance, stability, compatibility, and security: create points only when applicable and supported by facts. Missing thresholds, duration, browser/device matrices, or security rules must become Confirmation Items with `blocked_by_confirmation`; never invent values.
- Structure: use temporary `ref` and `parentRef` only. Keep grouping nodes useful and leaf nodes independently executable. Avoid synonymous duplicates and broad leaves that combine different roles, states, inputs, actions, or oracles.
- Content: every node must have a clear objective, dimension, priority, applicability, entry methods, oracle, data conditions, risks, assumptions, and at least one valid requirement basis ref. Historical refs are optional supporting context.
- Historical mapping: use `historicalRefs` only for frozen cases that materially support the point. Prefer a still-valid historical behavior, identify actually affected behavior, and do not create a new point merely to inflate coverage.
- Self-review: check all released requirements, requested scope, exclusions, dimensions, UI/API entry methods, historical mappings, cross-requirement flows, and risk areas before submitting one complete tree candidate.

Do not generate formal TP IDs, revisions, versions, hashes, database changes, or Workspace writes. This Skill cannot change Workflow Stage.
