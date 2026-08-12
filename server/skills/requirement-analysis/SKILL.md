---
name: requirement-analysis
description: Analyze a fixed current requirement workspace as one continuous task, producing a traceable requirement baseline, whole-set review, test focus, and self-review without treating historical knowledge as current facts.
---

# Requirement Analysis 方法论

在同一次 Session 中完成阅读、理解、基线、整体评审、跨需求评审、自检与提交。不要把这些阶段委派给其他 Agent，也不要在中间提交只含需求点的结果。

## 1. 建立事实边界

- 先从 `/workspace` 根目录浏览，定位活动分支的当前需求目录并逐份读到末尾；`ls`、`find` 和 `grep` 只帮助发现，`read` 返回的固定正文才可作为当前需求 Evidence。
- 当前需求目录中的内容是 Current Requirement。其他分支、`shared`、历史设计和 Knowledge 工具返回是 Knowledge Reference，只能用于发现差异、历史规则和待确认事项，不能自动升级为当前需求事实。
- 当知识资料与当前需求存在差异时，写成“历史资料说明什么、当前需求没有说明或与其不同、需要确认什么”，不得替业务做决定。

## 2. 整体理解与 Requirement Baseline

- 先形成业务目标、参与角色、核心对象、主流程、状态与上下游的整体理解，再拆 Requirement Point。
- Requirement Point 以可独立实现、测试或验收为最小粒度，同时保留条件、边界和结果等必要上下文。
- 逐项覆盖功能行为、主流程、分支流程、异常流程、状态转换、角色权限、数据约束、输入输出、边界条件和验收结果。
- 语义等价的重复项合并；冲突的要求分别保留，并在 Finding 中关联多个 Requirement Point。

## 3. 整体 Review

先检查全部需求集合，再形成 Finding。Finding 可以是：

- 单需求问题：歧义、缺失、边界、异常、数据、验收或可测试性不足；
- 跨需求问题：业务规则、状态、权限、术语、上下游或时序冲突，此时关联全部相关 Requirement Point；
- 整体问题：异常闭环、状态模型、权限模型、失败处理、迁移或非功能要求整体缺失，此时 Requirement Point 引用数组为空。

只有真实、独立且需要处理的问题才生成 Finding，不按需求点机械生成，也不按固定数量凑数。建议指出需要补充的规则、判定标准或业务决策，不擅自补写资料中不存在的结论。

## 4. 分析维度

按适用性检查以下维度；不适用时无需硬造 Finding：

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

## 6. Self Review

最终提交前在同一 Session 内检查：

- 主要业务流程和输入目录中的关键 Requirement 是否覆盖；
- 临时 RP ID 是否唯一有效，Finding 和 Test Focus 引用是否存在；
- 是否存在明显重复 Requirement 或 Finding；
- 是否把 Knowledge Reference 错当成 Current Requirement；
- 是否遗漏跨 Requirement 冲突、整体闭环或关键边界；
- Requirement Point 是否有逐字 `sourceTexts`；
- 关键结论是否能够通过相关 Requirement Point 的 Evidence 或清楚的“缺失事实”追溯；
- Summary、Finding、Test Focus 与分析文档是否相互一致。

完成自检后只提交一次完整 `requirement-analysis/v1`。
