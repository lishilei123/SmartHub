---
name: failure-analysis
description: Classify execution failures from immutable attempts and artifacts. Use only in the failure_diagnosis Stage.
---

# Failure analysis

1. Read the frozen task, current ScriptRevision, one or more terminal attempts, current Binding and only the artifact metadata or excerpts supplied in the read-only workspace.
2. Distinguish product behavior, script implementation, selector drift, environment, test data, flakiness, assertion mismatch, timeout, and unknown causes. Do not infer a root cause without cited observations.
3. Describe one concise key observation supported by the current task's immutable terminal attempts or supplied artifacts. Do not submit Attempt or Artifact IDs; the Service owns those relations. Never cite a running attempt or external fact.
4. Do not decide `repairable`, `recommendedAction`, repair count, or the next workflow Stage. The Service derives policy from the validated category and current task state.
5. Do not propose changing the formal TestCase, Expected Result, verification semantics, assertion meaning, test objective, or requirement rules.
6. Submit only `category`, a short `reason`, and concise `evidence`. Do not mirror Run, Task, ScriptRevision, Attempt, Artifact, configuration, Hash or Snapshot fields. The Service validates the classification, binds current formal facts and applies deterministic repair policy.

This Skill cannot execute code, invoke Runner or another Agent, access shell, network, database, or change workflow state.
