---
name: requirement-analysis
description: Analyze a fixed current requirement workspace as one continuous task, producing a traceable requirement baseline, necessary clarifications, and self-check without treating historical knowledge as current facts.
---

# Requirement Analysis 方法论

在同一次 Planning Session 中完成阅读、理解、基线、整体分析、跨需求分析、必要的 Clarification、自检与提交。不要把这些阶段委派给其他 Agent，也不要在中间提交只含需求点的结果。

## 1. 建立事实边界

- Current Requirement 的正式范围由服务端冻结的 Workspace 与输入覆盖计划确定，不由某一种工具调用决定。先使用已投递的重点输入建立理解；需要补充定位或核对时，可按需使用 `ls`、`find`、`grep` 或 `read` 浏览固定工作区，避免为了提交而重复读取无关正文。Requirement Point 只提交逐字 `sourceTexts`，Evidence、ID、定位与覆盖由服务端在固定输入中生成和校验。
- 当前需求目录中的内容是 Current Requirement。其他分支、`shared`、历史设计和 Knowledge 工具返回是 Knowledge Reference，只能用于发现差异、历史规则和待确认事项，不能自动升级为当前需求事实。
- 当知识资料与当前需求存在差异时，写成“历史资料说明什么、当前需求没有说明或与其不同、需要确认什么”，不得替业务做决定。

## 2. 整体理解与 Requirement Baseline

- 先形成业务目标、参与角色、核心对象、主流程、状态与上下游的整体理解，再拆 Requirement Point。项目级业务目标优先放入 `summary.businessGoals`，不应强行拆成 Requirement Point；若为追溯保留 Context Requirement Point，必须使用 `coverageTarget=false`。
- Requirement Point 以可独立实现、测试或验收为最小粒度，同时保留条件、边界和结果等必要上下文。每个提交点必须明确 `coverageTarget`：只有项目背景、项目目标、解释性上下文、文档说明等不产生独立业务行为或验收结果的 Context 才能为 `false`；CRUD、状态、输入约束、权限、枚举、查询、统计、异常、Expected Result、数据副作用和业务规则必须为 `true`。这不是按标题关键词判断，更不能为了通过 Coverage Audit 把难测 Requirement 标为 `false`。可选 `coverageRationale` 说明 Context 原因。
- 逐项覆盖功能行为、主流程、分支流程、异常流程、状态转换、角色权限、数据约束、输入输出、边界条件和验收结果。
- 语义等价的重复项合并；冲突的当前要求分别保留。若无法依据正式输入确定正确业务事实且会影响测试正确性，形成 Clarification。

## 3. 风险与事实缺口检查

先检查全部需求集合，但不要把“需求未写全”直接等同于 Clarification。每个未定义项只能归入以下一种结果：

1. **Blocking Clarification**：缺失的是必须由人工决定的核心业务事实；不回答就无法形成任何语义正确的核心 TestCase。
2. **Non-blocking test risk**：边界、异常、历史风险、Knowledge 推荐维度或覆盖扩展；可基于当前 Requirement 已明确部分继续形成正确核心 Case。这类风险不得包装成 Clarification 或新的结构化中间产物；后续测试设计会直接从 Requirement、Workspace 与 Knowledge 重新探索。
3. **Ignore**：对当前版本没有实际测试价值，不输出。

重点检查跨需求的业务规则、状态、权限、对象关系、术语、上下游与时序冲突。不得按需求点机械提问，也不得按固定数量凑数；不得擅自补写资料中不存在的结论。

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

## 5. 非阻断测试风险

高风险规则、关键状态、边界、异常、权限、并发、兼容性和 Knowledge 推荐维度不等于待人工处理的 Clarification。需求分析只负责判断它们是否暴露了必须确认的核心业务事实；测试风险本身由后续 PlanningAgent 在 TestCase Design 阶段结合连续 Context、Workspace 和 Knowledge 自主展开。

- 只要当前 Requirement 已能确定主流程的操作和 Expected Result，剩余未定义的覆盖扩展就不得阻断 Release，也不得新增结构化风险清单作为下游输入。
- 不得把未定义行为擅自断言为允许、禁止或特定 Expected Result。
- 例如“名称不能为空”已经支持正常非空名称与空字符串不能保存的核心 Case；纯空白、trim、Tab/换行、最大长度、字符集和唯一性应作为输入规范化风险，而不是 Blocking。
- 例如状态机已经给出合法转换和禁止回退时，状态自环、终态后的非状态字段编辑等未定义行为属于扩展风险；不得自行推导允许或禁止。
- Dashboard 已定义统计项目时，应关注源数据交叉验证和数据变化后的一致性；未定义刷新时点或复杂统计范围不能单独阻断。

## 6. Clarification

- `clarifications[]` 只保存需要人工处理的业务决策。普通测试风险不要为了记录而创建 `blocking=false` Clarification，也不要创建替代性的结构化中间产物；后续 TestCase Design 会从正式 Requirement、Clarification、Workspace 与 Knowledge 直接重新探索。
- 一个 Clarification 只有**同时**满足以下全部条件，才允许 `blocking=true`：
  1. 缺失的是当前产品的业务事实，不是测试方法、经验或最佳实践；
  2. Current Requirement、已回答的 Formal Clarification 与完整 Workspace 都无法确定该事实；
  3. Knowledge 只能提示风险，不能提供该业务事实；
  4. 该事实会直接改变核心操作是否成立、核心对象的数据关系、合法/非法状态、权限允许/禁止规则或核心 Expected Result 中至少一项；
  5. 不回答时，无法生成至少一个语义正确的核心 TestCase；
  6. 不能通过“只测试当前 Requirement 已明确的部分”继续完成测试设计。
- `question` 必须直接询问缺失的业务事实；`reason` 必须说明该事实缺失会使哪个核心 TestCase 或 Expected Result 无法正确确定；每个 blocking 问题必须关联实际 Requirement Point。多个相关问题应合并为一个核心业务决策，禁止为每个测试维度分别创建问题。
- 以下情况默认**不得**生成 Blocking Clarification：Knowledge 推荐额外场景；已有明确核心语义但缺少额外边界；只影响覆盖深度、错误文案或页面提示；可先生成当前 Requirement 的正确核心 Case；通用测试最佳实践。
- 例如“删除项目时同步删除任务”却没有定义任务与项目的关联模型时，可以 Blocking，因为无法准备可靠的级联删除数据并验证核心结果。登录成功后的跳转、会话形式或提示文案，查询组合细节、删除确认取消分支、输入 trim/长度/字符集等不适合整体 Blocking。
- Knowledge Reference 只能提醒风险、推荐测试维度、提示历史缺陷模式或边界/异常场景。除非知识明确是当前项目已确认的正式业务规范，否则不得因 Knowledge 自身包含规则而要求人工确认，更不得把它升级为 Current Requirement 事实。
- 不得假设次数、时长、阈值、权限、状态规则、期望结果、依赖契约、范围或环境配置。真正满足上述条件的缺失应提出具体问题并说明核心影响。
- 一次分析提交必须汇总当前已识别的全部 blocking Clarification，不得拆成逐题追问或预留下一轮才提问。人工会先完整回答这一批问题，Service 再一次性恢复 Planning 流程。
- `status=answered` 的 Human Answer 是服务端保存的正式业务事实。继续分析时从固定 `formalClarifications` 重新读取，不依赖 Context Summary 或模型记忆，并将答案吸收到更新后的 Requirement Understanding 中。
- `status=dismissed` 表示人工决定问题不适用或接受当前需求缺口；其 answer 只是可追溯的处置理由，不得作为业务规则、权限、边界、Expected Result 或测试断言依据。保留缺口并只在当前正式需求可验证范围内继续。

## 7. Self Review

最终提交前在同一 Session 内检查：

- 主要业务流程和输入目录中的关键 Requirement 是否覆盖；
- 临时 RP ID 是否唯一有效；
- 是否存在明显重复 Requirement；
- 是否把 Knowledge Reference 错当成 Current Requirement；
- 是否遗漏跨 Requirement 冲突、整体闭环或关键边界；
- Requirement Point 是否有逐字 `sourceTexts`；
- 关键结论是否能够通过相关 Requirement Point 的 Evidence 或清楚的“缺失事实”追溯；
- Summary 与分析文档是否相互一致。
- Clarification 是否只包含仍需人工处理的业务决策；普通风险是否没有被包装成非阻断问题或新的中间产物。
- 对每一个 `blocking=true` 自问：“如果用户不回答，我是否真的无法基于当前 Requirement 生成任何语义正确的核心测试？”答案是否定时，必须移除该 Clarification。
- 多个 blocking 问题是否其实是同一项核心业务决策，能够合并后一次询问。

完成自检后只提交一次完整 `requirement-analysis/v1`。`clarifications` 只包含本轮新识别且仍待人工处理的问题；固定 Snapshot 中已有的 answered/dismissed 历史由服务端合并，不得重复提交；没有新问题时提交空数组。
