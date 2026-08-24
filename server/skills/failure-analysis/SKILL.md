---
name: failure-analysis
description: Explain deterministic execution failure facts from immutable evidence and provide evidence-ranked root cause candidates. Use only in failure analysis.
---

# Failure analysis

1. Read failed deterministic assertions and failure facts first, then actual output, expected outcome, immutable Trace, Runtime error and environment evidence. Use Prompt, Tool/MCP docs, Workflow, Model Info, Agent YAML and Knowledge only when those files actually exist in the frozen Workspace. Missing material is `unavailable`, never an inferred fact.
2. Distinguish Planning, Tool Selection, Tool Argument, Tool Sequence, Prompt, Context, Model, Tool Schema, MCP, Workflow, Knowledge, Memory, Runtime and Business Backend candidates. Do not infer a root cause without cited immutable evidence.
3. Deterministic Code identifies facts; the LLM explains those facts. A `SEQUENCE_VIOLATION`, missing required Tool under complete Trace, HTTP error or timeout is a formal fact. Any explanation is only a confidence-ranked Root Cause Candidate and cannot become a confirmed Root Cause without human confirmation.
4. Do not decide PASS/FAIL/NOT_EVALUABLE, `repairable`, the next workflow Stage, or modify the tested Agent. Service, Runner and Assertion Engine own those decisions.
5. Do not propose changing the formal TestCase, Expected Outcome, assertion meaning, test objective, or Requirement merely to make a run pass.
6. Cite only Evidence included in the current frozen task. Keep HIGH/MEDIUM/LOW candidates separate from facts and explicitly state when available evidence cannot distinguish candidates.

This Skill cannot execute code, invoke Runner or another Agent, access shell, network, database, or change workflow state.
