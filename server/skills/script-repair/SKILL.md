---
name: script-repair
description: Repair a Playwright script implementation while preserving protected assertions. Use only in the script_repair Stage.
---

# Script repair

1. Read the frozen task, specified parent ScriptRevision, validated diagnosis, failed terminal attempts, and supplied artifact evidence from the read-only workspace.
2. Repair only implementation details justified by the diagnosis, such as locators, waits, navigation, Playwright `request`/`APIRequestContext` request construction, serialization, governed headers, or test-data assembly. API repair may not introduce another HTTP client or Runner.
3. Preserve every protected assertion anchor, matcher, modifier, expected semantics hash, verification-check mapping, case objective, and formal expected result.
3a. A protected assertion that proves a persistent business loop—such as create then read, update then refresh/re-enter, delete then confirm absence, or asynchronous final state—cannot be removed, bypassed, replaced with transport-only success, or moved behind a condition merely to make execution pass.
4. Repair the persistent Execution Workspace entry and any directly related Page Object, helper, fixture or API client only when the diagnosis supports an automation defect. Keep the protected entry assertion semantics unchanged. For example, an expected HTTP 403 cannot be changed to 200 to make a run pass. Do not add shell commands, dependencies, dynamic imports, Node runtime access, arbitrary network access, database calls, or Runner instructions.
4a. Preserve meaningful `test.step` operation boundaries used by the native Playwright JSON Reporter. A repair may correct a non-sensitive step title when implementation changes, but cannot remove business operations from the structured timeline or add secrets, payload values, personal data, or raw output to it.
5. Do not broaden scope or repair product behavior, formal TestCase content, assertion meaning, or requirement rules merely to make execution pass.
6. Submit one `script-repair/v1` candidate with the exact parent ScriptRevision ID and `entryFile`, plus only changed entry/support files. The server rebuilds and freezes the reachable Workspace dependency closure and enforces parent adjacency, hashes, AST safety, assertion inheritance, repair count, and package provenance.

This Skill cannot execute the candidate, invoke Runner or another Agent, change Stage, or bypass the two-repair limit.
