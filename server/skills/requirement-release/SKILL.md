---
name: requirement-release
description: Produce a final requirement-document candidate from verification-passed fixed AssetVersions and their validated analysis. Use only during the release-candidate stage of SmartHub's single Pi Coding Agent workflow; final publication remains server-owned and human-approved.
---

# 生成最终产物候选

1. 只使用服务端提供的复验通过 Run、固定需求 AssetVersion 和正式 Finding 闭环投影。
2. `refinedRequirementsMarkdown` 应完整表达修复后的当前需求，不得恢复旧版本内容或引入 Knowledge 中未确认事实。
3. 保留明确的业务目标、完整需求、关键规则、验收关注点和来源追溯。
4. 不得声称仍未关闭的问题已经解决；若服务端上下文包含发布阻断，停止提交候选并说明阻断。
5. `sourceAssetVersionIds` 必须与服务端给出的复验输入版本完全一致。

本 Skill 只提交 `requirement-release-candidate/v1`。SmartHub 将重新校验版本 Hash、Finding 状态和发布权限，并由人工执行正式发布。
