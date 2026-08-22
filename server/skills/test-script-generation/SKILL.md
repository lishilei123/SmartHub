---
name: test-script-generation
description: Implement a TestCase entry in the persistent ProjectVersion Execution Workspace. Use only in the script_generation Stage.
---

# Test script generation

1. Read the frozen TestCase v3, selected `executionMethod`, Execution Context, environment signature, server-derived assertion anchors, and the `execution/` workspace projection.
2. Query controlled Knowledge before implementing API or UI behavior. Read existing tests, Page Objects, helpers, fixtures, API clients and bindings first; reuse them instead of recreating equivalent code.
3. Submit an entry file plus only the workspace files that must be added or changed. The entry is a stable Case → entry-file → entry-symbol binding, not a disposable one-case artifact. Multiple Cases may share support files.
4. Implement every `expectedResults` item exactly once through the server-derived assertion anchors. Preserve its expected semantics; do not weaken, omit, invert, or replace business assertions.
5. Do not invent credentials, environment values, business rules, APIs, selectors, thresholds, or expected results. Local Runner validates the submitted implementation against the supplied BaseURL; a failed run is evidence, not permission to change intent.
6. Do not include shell commands, package installation, dynamic imports, Node runtime access, arbitrary network utilities, database access, or Runner instructions.
7. Submit only a `test-script-generation/v1` candidate. The server validates paths, hashes, AST, assertion coverage, package provenance, binding scope and readiness before any Runner launch.

This Skill cannot execute code, invoke Runner, call another Agent, change the workflow Stage, or expand the Tool whitelist.
