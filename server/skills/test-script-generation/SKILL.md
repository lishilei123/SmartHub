---
name: test-script-generation
description: Generate one Playwright UI or API script candidate from a frozen execution task. Use only in the script_generation Stage.
---

# Test script generation

1. Read the frozen task, case content, execution specification, environment signature, and server-provided assertion contract from the current read-only workspace.
2. Generate exactly one TypeScript file at the server-specified `tests/<task-id>.spec.ts` entrypoint. Use only static imports allowed by the ExecutionPackage contract.
3. Implement every frozen verification check exactly once. Preserve its anchor and expected semantics; do not weaken, omit, invert, or replace business assertions.
4. Do not invent credentials, environment values, business rules, APIs, selectors, thresholds, or expected results. If the frozen input is insufficient, return a candidate that the server can reject rather than hiding the gap.
5. Do not include shell commands, package installation, configuration files, dynamic imports, Node runtime access, network utilities, database access, or Runner instructions.
6. Submit only a `test-script-generation/v1` candidate. The server validates paths, hashes, AST, dependencies, assertion coverage, package provenance, and readiness before any Runner launch.

This Skill cannot execute code, invoke Runner, call another Agent, change the workflow Stage, or expand the Tool whitelist.
