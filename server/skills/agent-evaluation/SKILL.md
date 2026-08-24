---
name: agent-evaluation
description: Evaluate only semantic Agent Test criteria from frozen outputs and evidence without replacing deterministic assertions.
---

# Agent semantic evaluation

1. Read the frozen Agent Test Spec and every repeat's actual output, immutable Trace and deterministic assertion results.
2. Evaluate only Task Completion, semantic and safety criteria supplied by the Service. Never re-evaluate HTTP status, timeout, Tool presence, arguments, sequence, step count or cost.
3. Return PASS or FAIL only when cited visible evidence supports the conclusion. Return NOT_EVALUABLE when evidence is missing, ambiguous or the criterion requires unavailable business state.
4. Do not invent Requirement facts, hidden Tool calls, Prompt, Workflow, Model behavior or business state. Seeing no Tool event is not proof that the Tool did not run.
5. Keep each criterion separate; do not replace results with an overall score. Evidence references must identify Trace events delivered in the current task.

Submit one result for every Service-provided criterion and repeat. The Service validates exact membership and evidence references before persistence.
