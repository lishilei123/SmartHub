---
name: test-script-generation
description: Implement a TestCase entry in the persistent ProjectVersion Execution Workspace. Use only in the script_generation Stage.
---

# Test script generation

1. Read the frozen TestCase v3, selected `executionMethod`, Execution Context, environment signature, server-derived assertion anchors, and the `execution/` workspace projection.
2. If this is an API Case without a Binding, first read `/exploration/context.json`, then query the Run-frozen Knowledge index for API documentation only when needed, and then read `execution/api/`, `execution/helpers/`, `execution/fixtures/` and `execution/tests/api/`. Prefer a relevant, validated, same-environment observation over exploring the endpoint from zero, but treat inherited, stale or mismatched observations as needing validation.
3. Exploration Context is runtime-observed knowledge, not Requirement truth. If it conflicts with API documentation, preserve the difference and identify it as possible documentation drift, environment-version drift, product behavior, or invalid exploration; never silently let either source rewrite the TestCase intent.
4. UI Cases must still perform and assert the real UI flow. An observed Endpoint may help understanding and shared-client implementation, but direct API calls cannot replace UI input, interaction, navigation, or page-result verification.
5. Implement an API Case with Playwright Test's built-in `request` fixture by default. Shared API clients must receive an `APIRequestContext` from the Case or a governed fixture; never create or import axios, superagent, undici, node:http, node:https, fetch polyfills, Postman/Newman, Python HTTP clients, RestAssured, or another API Runner.
6. Reuse an operation-oriented client such as `AuthClient.login/logout/refreshToken` across Cases; never create one client per Case. Keep request construction and reusable operations in the client, while keeping business assertions and every `smarthub:assert` anchor next to the Case entry.
7. The Playwright `page` and `request` fixtures both use the current ExecutionRun BaseURL. Use relative URLs and never hard-code a Host or replace it with an Exploration/API-documentation origin. A mixed UI/API test may use `request` for setup or cleanup, but a UI Case must still use `page` for the tested UI action and assertion; API setup cannot replace UI intent.
8. Submit `entryFile` plus only the workspace files that must be added or changed. The entry title and entry symbol are the exact frozen Case ID. The binding remains Case → entry-file → entry-symbol; multiple Cases may share a spec or support files such as `api/auth-client.ts`.
9. Implement every `expectedResults` item exactly once through the server-derived assertion anchors. Preserve its expected semantics; do not weaken, omit, invert, or replace business assertions.
10. Do not invent credentials, environment values, business rules, APIs, selectors, thresholds, or expected results. Authentication comes only from frozen Test Data, an existing governed fixture, the current Environment, or Runtime Secret references. Never recover redacted values or write Authorization, Cookie, Token, Password, Session, API Key or personal data into Workspace source.
11. Do not include shell commands, package installation, dynamic imports, Node runtime access, arbitrary network utilities, database access, or Runner instructions.
12. Submit only a `test-script-generation/v1` candidate. The server validates paths, hashes, the reachable relative dependency closure, AST safety, UI/API fixture intent, assertion coverage, package provenance, binding scope and readiness before any Runner launch.

This Skill cannot execute code, invoke Runner, call another Agent, change the workflow Stage, or expand the Tool whitelist.
