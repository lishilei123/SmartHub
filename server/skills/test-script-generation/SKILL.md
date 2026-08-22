---
name: test-script-generation
description: Implement a TestCase entry in the persistent ProjectVersion Execution Workspace. Use only in the script_generation Stage.
---

# Test script generation

1. Read the frozen TestCase v3, selected `executionMethod`, Execution Context, environment signature, server-derived assertion anchors, and the `execution/` workspace projection.
2. If this is an API Case without a Binding, first read `/exploration/context.json`, then query the Run-frozen Knowledge index for API documentation only when needed, and then read existing tests, Page Objects, helpers, fixtures, API clients and bindings. Prefer a relevant, validated, same-environment observation over exploring the endpoint from zero, but treat inherited, stale or mismatched observations as needing validation.
3. Exploration Context is runtime-observed knowledge, not Requirement truth. If it conflicts with API documentation, preserve the difference and identify it as possible documentation drift, environment-version drift, product behavior, or invalid exploration; never silently let either source rewrite the TestCase intent.
4. UI Cases must still perform and assert the real UI flow. An observed Endpoint may help understanding and shared-client implementation, but direct API calls cannot replace UI input, interaction, navigation, or page-result verification.
5. Submit an entry file plus only the workspace files that must be added or changed. The entry is a stable Case → entry-file → entry-symbol binding, not a disposable one-case artifact. Multiple Cases may share support files such as `api/auth-client.ts`; do not force a UI Case to bypass the UI through that client.
6. Implement every `expectedResults` item exactly once through the server-derived assertion anchors. Preserve its expected semantics; do not weaken, omit, invert, or replace business assertions.
7. Do not invent credentials, environment values, business rules, APIs, selectors, thresholds, or expected results, and never attempt to reconstruct redacted Authorization, Cookie, Token, Password, Session, API Key or personal data. Local Runner validates the submitted implementation against the supplied BaseURL; a failed run is evidence, not permission to change intent.
8. Do not include shell commands, package installation, dynamic imports, Node runtime access, arbitrary network utilities, database access, or Runner instructions.
9. Submit only a `test-script-generation/v1` candidate. The server validates paths, hashes, AST, assertion coverage, package provenance, binding scope and readiness before any Runner launch.

This Skill cannot execute code, invoke Runner, call another Agent, change the workflow Stage, or expand the Tool whitelist.
