---
name: script-repair
description: Repair a Playwright script implementation while preserving protected assertions. Use only in the script_repair Stage.
---

# Script repair

1. Read the frozen task, specified parent ScriptRevision, validated diagnosis, failed terminal attempts, and supplied artifact evidence from the read-only workspace.
2. Repair only implementation details justified by the diagnosis, such as locators, waits, navigation, request setup, or test-data assembly.
3. Preserve every protected assertion anchor, matcher, modifier, expected semantics hash, verification-check mapping, case objective, and formal expected result.
4. Keep the fixed single entrypoint and allowed imports. Do not add shell commands, dependencies, dynamic imports, Node runtime access, arbitrary network access, database calls, or Runner instructions.
5. Do not broaden scope or repair product behavior, formal TestCase content, assertion meaning, or requirement rules merely to make execution pass.
6. Submit one `script-repair/v1` candidate with the exact parent ScriptRevision ID. The server enforces parent adjacency, hashes, AST safety, assertion inheritance, repair count, and package provenance.

This Skill cannot execute the candidate, invoke Runner or another Agent, change Stage, or bypass the two-repair limit.
