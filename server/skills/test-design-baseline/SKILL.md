---
name: test-design-baseline
description: Establish the immutable fact and risk baseline for TestDesignAgent from a frozen ProjectVersion Workspace and bound Requirement Release. Use during test_point_design before deriving test points.
---

# Test design baseline

1. Start at `/workspace`; inspect the active branch and read `requirements/requirements.json` completely. Treat its frozen Requirement Release as the primary source of truth.
2. Read API, UI, environment, technical, historical-case, defect, and shared Knowledge material only when relevant and available. Treat it as enhancement context, never as a replacement for a released requirement.
3. Build an internal map of business goals, actors, permissions, state transitions, inputs, outputs, interfaces, data effects, failure paths, and observable oracles. Do not emit a coverage-unit artifact.
4. Preserve facts with only basis or historical refs exposed by the frozen run. Do not invent formal IDs, versions, revisions, hashes, or evidence.
5. If a threshold, compatibility matrix, permission decision, timeout rule, or other business rule is absent, create a Confirmation Item. Never supply a plausible value from general knowledge.

This Skill provides methods only. It cannot change Stage, activate tools, write Workspace files, publish versions, or modify the database.
