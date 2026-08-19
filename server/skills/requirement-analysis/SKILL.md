---
name: requirement-analysis
description: Analyze a fixed current requirement workspace as one continuous task, producing a traceable requirement baseline, clarifications, test focus, and self-check without treating historical knowledge as current facts.
---

# Requirement Analysis 方法论

在同一次 Planning Session 中完成阅读、理解、基线、整体分析、跨需求分析、必要的 Clarification、自检与提交。不要把这些阶段委派给其他 Agent，也不要在中间提交只含需求点的结果。

## 1. 建立事实边界

- Current Requirement 的正式范围由服务端冻结的 Workspace 与输入覆盖计划确定，不由某一种工具调用决定。先使用已投递的重点输入建立理解；需要补充定位或核对时，可按需使用 `ls`、`find`、`grep` 或 `read` 浏览固定工作区，避免为了提交而重复读取无关正文。Requirement Point 只提交逐字 `sourceTexts`，Evidence、ID、定位与覆盖由服务端在固定输入中生成和校验。
- 当前需求目录中的内容是 Current Requirement。其他分支、`shared`、历史设计和 Knowledge 工具返回是 Knowledge Reference，只能用于发现差异、历史规则和待确认事项，不能自动升级为当前需求事实。
- 当知识资料与当前需求存在差异时，写成“历史资料说明什么、当前需求没有说明或与其不同、需要确认什么”，不得替业务做决定。

## 2. 整体理解与 Requirement Baseline

- 先形成业务目标、参与角色、核心对象、主流程、状态与上下游的整体理解，再拆 Requirement Point。
- Requirement Point 以可独立实现、测试或验收为最小粒度，同时保留条件、边界和结果等必要上下文。
- 逐项覆盖功能行为、主流程、分支流程、异常流程、状态转换、角色权限、数据约束、输入输出、边界条件和验收结果。
- 语义等价的重复项合并；冲突的当前要求分别保留。若无法依据正式输入确定正确业务事实且会影响测试正确性，形成 Clarification。

## 3. 风险与事实缺口检查

先检查全部需求集合，识别会影响测试正确性的未确定业务事实：

- 单需求中的歧义、缺失、边界、异常、数据、验收或可测试性不足；
- 跨需求的业务规则、状态、权限、术语、上下游或时序冲突；
- 整体需求中异常闭环、状态模型、权限模型、失败处理、迁移或非功能要求的关键缺失。

仅当缺失事实会导致测试用例的规则、边界或预期结果不可靠时，才生成 blocking Clarification；不按需求点机械提问，也不按固定数量凑数。不得擅自补写资料中不存在的结论。

## 4. 分析维度

按适用性检查以下维度；不适用时无需硬造问题：

1. 需求整体理解与业务目标；
2. 功能完整性；
3. 主流程；
4. 分支流程；
5. 异常、失败、取消、超时、重试和恢复；
6. 状态定义与合法/非法状态转换；
7. 角色、权限和数据范围；
8. 数据实体、字段、约束、生命周期和迁移；
9. 输入、输出和可观察结果；
10. 空值、格式、长度、上下界和组合边界；
11. 业务规则及优先级；
12. 跨需求一致性；
13. 上下游依赖、接口和副作用；
14. 幂等性和重复提交；
15. 并发、竞态和一致性；
16. 安全、隐私、审计和越权；
17. 性能、容量和时延；
18. 兼容性、升级、回滚和历史数据；
19. 可测试性和验收判定；
20. 其他非功能要求。

## 5. Test Focus

Test Focus 不是完整测试用例。为高风险规则、关键状态、边界、异常、权限、并发、兼容性和待确认决策给出可行动的测试关注点，并关联适用的 Requirement Point；整体关注点可以使用空引用数组。

## 6. Clarification

- 只有 Current Requirement、完整 Workspace 与 Knowledge Reference 都无法确定，且会影响测试用例正确性的业务事实才生成 Clarification。
- 不得假设次数、时长、阈值、权限、状态规则、期望结果、依赖契约、范围或环境配置。此类缺失应提出具体问题并说明原因。
- 改进建议或不影响测试正确性的资料缺口不进入本轮正式结果。
- `blocking=true` 只用于不回答就无法形成正确测试设计的事实；其他可选确认使用 `blocking=false`。
- 一次分析提交必须汇总当前已识别的全部 blocking Clarification，不得拆成逐题追问或预留下一轮才提问。人工会先完整回答这一批问题，Service 再一次性恢复 Planning 流程。
- `status=answered` 的 Human Answer 是服务端保存的正式业务事实。继续分析时从固定 `formalClarifications` 重新读取，不依赖 Context Summary 或模型记忆，并将答案吸收到更新后的 Requirement Understanding 中。
- `status=dismissed` 表示人工决定问题不适用或接受当前需求缺口；其 answer 只是可追溯的处置理由，不得作为业务规则、权限、边界、Expected Result 或测试断言依据。保留缺口并只在当前正式需求可验证范围内继续。

## 7. Self Review

最终提交前在同一 Session 内检查：

- 主要业务流程和输入目录中的关键 Requirement 是否覆盖；
- 临时 RP ID 是否唯一有效，Test Focus 引用是否存在；
- 是否存在明显重复 Requirement；
- 是否把 Knowledge Reference 错当成 Current Requirement；
- 是否遗漏跨 Requirement 冲突、整体闭环或关键边界；
- Requirement Point 是否有逐字 `sourceTexts`；
- 关键结论是否能够通过相关 Requirement Point 的 Evidence 或清楚的“缺失事实”追溯；
- Summary、Test Focus 与分析文档是否相互一致。
- Clarification 是否只包含无法从正式输入确定的事实，blocking 是否确实影响测试设计正确性。

完成自检后只提交一次完整 `requirement-analysis/v1`。`clarifications` 只包含本轮新识别且仍待人工处理的问题；固定 Snapshot 中已有的 answered/dismissed 历史由服务端合并，不得重复提交；没有新问题时提交空数组。
