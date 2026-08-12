---
name: requirement-baseline
description: Read the fixed current requirement workspace and establish a complete, atomic, evidence-traceable requirement baseline. Use during the baseline stage of SmartHub's single Pi Coding Agent requirement workflow, including initial analysis and post-repair verification.
---

# 建立需求基线

1. 从 `/workspace` 根目录开始，用 `ls`、`find` 建立当前分支需求文件清单。
2. 对范围内每份需求文件使用 `read` 读到末尾；`grep` 只能辅助定位。
3. 先形成业务目标、角色、对象、主流程、状态与依赖的整体理解，再拆分需求点。
4. 需求点以可独立实现、测试或验收为最小粒度，同时保留条件、边界和结果。
5. `sourceTexts` 只能复制本次 `read` 返回的连续逐字原文。不得把 Knowledge 或其他分支内容写成当前需求事实。
6. 语义等价项可以合并；互相冲突的当前要求分别保留，交给审核阶段形成 Finding。
7. 在进入审核前检查文件覆盖、需求遗漏、重复点、临时 ID 和原文追溯。

本 Skill 只指导建立基线，不修改需求、不关闭 Finding、不发布产物。后续是否激活其他 Skill 由 Agent 根据当前 Stage 的任务自行决定。
