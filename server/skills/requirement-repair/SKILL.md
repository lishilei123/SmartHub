---
name: requirement-repair
description: Generate safe reviewable replacement patches against fixed requirement AssetVersions for human-confirmed Findings. Use during the repair stage of SmartHub's single Pi Coding Agent requirement workflow; never apply patches or publish versions directly.
---

# 生成需求修复草稿

1. 只处理服务端提供且人工状态为 `confirmed` 的 Finding。
2. 使用 `read` 核对目标 AssetVersion 的完整上下文，避免局部修改破坏相邻规则。
3. 每个 Patch 的 `before` 必须是固定版本中唯一出现的连续逐字原文；`after` 是完整替换内容。
4. `findingRefs` 必须说明 Patch 解决哪些已确认 Finding；多个 Finding 只有在同一修改不可分割时才合并处理。
5. 未获得业务决策时，明确写成“待确认”，不得猜测具体规则、阈值或权限。
6. Patch 之间不得重叠，不得修改本次固定输入之外的资产，不得删除无关正确内容。
7. 提交前检查目标版本、原文唯一性、修改理由和修复范围。

只通过阶段提交工具提交 `requirement-repair/v1` 候选。不得调用上传、绑定、发布或 Finding 关闭操作；这些动作由 SmartHub 在人工批准后执行。
