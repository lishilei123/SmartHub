---
name: requirement-verification
description: Re-read and fully analyze repaired requirement AssetVersions, checking whether prior Findings are actually removed without regressions. Use during the verification stage of SmartHub's single Pi Coding Agent requirement workflow after approved patches have produced new versions.
---

# 复验修复后的需求

1. 将修复后的 AssetVersion 当作新的完整输入，从头执行需求基线和整体审核，不只检查 Patch 附近文本。
2. 对服务端给出的原 Finding 逐项判定：已消除、仍存在或产生新问题。
3. 不沿用旧 Requirement Point、Evidence、Summary 或评分；全部依据新固定版本重新形成。
4. 检查修复是否造成语义重复、跨文档冲突、状态断裂、异常遗漏或不可测试描述。
5. 原问题仍存在时生成新的 Finding，并清楚说明残留原因；新发现的问题按正常审核规则提交。
6. 只有新结果不存在发布阻断且 Summary 与 Finding 一致时，才可给出 `pass` 或允许的 `pass_with_notes`。

本 Skill 不直接把旧 Finding 改为 `resolved`。SmartHub 根据新运行、输入版本 Hash 和新 Finding 计算闭环与发布门禁。
