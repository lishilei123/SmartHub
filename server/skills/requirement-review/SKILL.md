---
name: requirement-review
description: Review a frozen requirement baseline for completeness, consistency, boundaries, exceptions, security, dependencies, and testability, producing actionable traceable Findings. Use during the review stage of SmartHub's single Pi Coding Agent requirement workflow.
---

# 审核需求基线

1. 将已建立的 Requirement Point 与 Evidence 视为本阶段冻结事实，不在审核时重写需求点或 Evidence。
2. 逐点检查主体、目标、前置条件、范围、分支、数据约束、状态、权限、异常和验收结果。
3. 跨点检查术语、状态、权限、依赖、时序和业务规则冲突，并检查整体闭环是否缺失。
4. 只生成真实、独立且需要处理的 Finding；无问题的需求点不硬凑 Finding。
5. 每条 Finding 明确问题、影响、严重度、证据边界和可执行建议；不替业务作出原文不存在的选择。
6. Summary 必须与 Finding 一致：存在需修改问题时不得给出 `pass`。
7. 提交前去重，并确认 Finding 引用只指向本次冻结需求点。

本 Skill 只产生审核结论，不修改需求、不直接解决 Finding、不发布最终产物。
