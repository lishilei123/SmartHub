# 第四期：多 Agent 测试设计工作流技术文档

| 项目 | 内容 |
|---|---|
| 产品名称 | SmartHub |
| 阶段 | Phase 4：多 Agent 测试设计工作流 |
| 文档版本 | V1.0 |
| 文档状态 | 实施设计稿，功能尚未实现 |
| 编制日期 | 2026-08-06 |
| 对应需求 | [第四期-多Agent测试设计工作流需求文档.md](../需求文档/第四期-多Agent测试设计工作流需求文档.md) V1.4 |
| 当前代码基线 | Phase 1 + Phase 2 + Phase 3 已实现，数据库迁移最高版本为 14 |

本文给出第四期的实施级技术设计。文档中的表、接口、模块和配置均为待实现方案，不表示当前仓库已经交付测试设计、测试数据创建、脚本生成或测试执行能力。

---

## 1. 文档目标

本文回答以下实施问题：

1. 如何在现有 Pi Agent Runtime、Agent 配置、Tool Runtime、PostgreSQL Worker 和固定 Evidence 基础上增加服务端固定 DAG；
2. 如何同时支持 `review_baseline` 与 `knowledge_assets` 两种互斥主依据，并保证输入、召回和历史用例不漂移；
3. 如何让四个 Agent 分工完成五阶段产物链，同时由服务端拥有 ID、关系、Hash、覆盖统计、状态和发布权限；
4. 如何实现测试点树 revision/ETag、用例在线编辑、历史复用、审核和覆盖审计失效传播；
5. 如何发布不可变、机器可读、可供后续执行阶段直接消费的 `TestCaseSetVersion`；
6. 如何将 FR-601～FR-613、AC-401～AC-415落实到数据、API、前端、测试和发布门禁。

---

## 2. 范围与边界

### 2.1 本期交付

- 测试设计创建、历史列表、固定运行和三栏工作台；
- 两种主依据模式及严格判别联合校验；
- 固定知识增强、查询计划、召回结果和空召回快照；
- 固定历史用例输入及适用性分析；
- 只由服务端发布的 `test-design-workflow/v1` DAG；
- `TestAnalysisAgent`、`FunctionalTestDesignAgent`、`NonFunctionalTestDesignAgent`、`TestCaseSynthesisAgent` 四个独立 Agent；
- 分析范围门禁、功能/非功能并行设计、测试点树人工门禁、用例/数据具象化和服务端覆盖审计；
- 测试点树结构化编辑、revision、ETag、Diff 和批准版本；
- UI/API 结构化用例、独立数据需求、历史复用关系、用例 revision 和人工审核；
- JSON、Markdown、Excel 导出及不可变 `TestCaseSetVersion` 发布；
- `test_case` 知识资产展示投影的异步、幂等入库；
- 节点级重试、重新具象化、全部重跑、取消、租约、恢复和迟到结果隔离。

### 2.2 本期不做

- 不生成 Playwright、接口、性能、安全或其他测试脚本；
- 不连接浏览器、接口、数据库、压测平台、故障注入平台、安全扫描器或真实测试环境；
- 不创建、导入、重置或清理真实测试数据；
- 不读取或写入 Git、分支、Commit、Pull Request、Patch；
- 不执行 Shell、任意 HTTP、宿主文件系统或外部写操作；
- 不创建缺陷，不接入 CI/CD，不分析真实执行日志、截图、视频或 Trace；
- 不提供面向用户的通用 DAG 编辑器，也不允许 Agent 自主委派；
- 不实现组织级 ACL、SSO、多人会签或外部工单同步。

开发和验收过程可以使用 Playwright 验证 SmartHub 自身页面，但该行为属于工程测试，不是第四期产品 Agent 的测试执行能力。

### 2.3 交付完成判定

第四期完成必须同时满足：

1. PostgreSQL 独立 Worker 路径支持固定 DAG、并行、门禁、恢复、取消和 fencing；
2. 两种依据模式均通过完整自动化验收，不依赖前端模拟数据；
3. 四个 Agent 均有独立发布配置和独立会话；
4. 测试点树、用例、数据需求、覆盖审计和发布版本均真实持久化；
5. 固定路由 `projectVersionId + testDesignId + workflowRunId` 刷新后恢复同一上下文；
6. 发布 JSON 通过 `test-case-set/v1`，且报告/Excel与同一规范对象一致；
7. `npm run migrate`、`npm test`、`npm run build` 和 `git diff --check` 全部通过；
8. README、需求文档、技术文档与最终实现边界一致。

---

## 3. 当前基线与实施差距

### 3.1 可直接复用的代码基线

| 现有模块 | 可复用能力 |
|---|---|
| `server/agent/pi-agent-runtime.ts` | Pi Agent 的模型、消息、工具循环、取消和公开事件采集。 |
| `server/application/agent-configuration-service.ts` | Agent 草稿、发布版本、模型路由、Prompt、Tool/MCP/Skill 与限制快照。 |
| `server/tools/runtime.ts`、`registry.ts` | Tool 白名单、参数、超时、取消、结果大小和脱敏治理。 |
| `server/agent/*context-assembler.ts` | 完整正文优先、超预算确定性分段及 `InputDeliveryManifest` 思路。 |
| `server/agent/evidence-locator.ts` | 固定正文内原文定位和服务端 Evidence 生成能力。 |
| `server/application/technical-solution-review-service.ts` | 固定 Phase 2/3 基线、运行快照、结果 Hash 和人工处置模式。 |
| `server/worker.ts` | PostgreSQL Job 领取、heartbeat、run token、有限重试、取消和 fencing 算法。 |
| `server/infrastructure/postgres-store.ts` | 事务、窄查询、分页和 `FOR UPDATE SKIP LOCKED` 实现模式。 |
| `server/http/access-control.ts` | 可信 Principal 与项目版本权限检查接口。 |
| Phase 1 资产/索引 | 固定 `assetVersionId`、Chunk、内容 Hash、固定索引和混合检索基础。 |
| Phase 2/3 正式结果 | 冻结需求点、方案要点、Finding、Evidence 和来源运行链。 |

### 3.2 不可直接复用的部分

- 当前 `server/worker.ts` 按知识任务、需求评审 Job、技术方案 Job 三类队列顺序领取，不具备 DAG 节点依赖和公平调度；
- 当前 `review_jobs` 与 `technical_solution_review_jobs` 都是一运行一 Job，不能表达并行节点、人工门禁和节点级重试；
- 当前 `AgentDefinitionVersion` 和 Agent 配置联合类型只包含五个既有 Agent；
- 当前 `knowledge.search` 工具虽然校验固定索引和资产 allowlist，但只提供降级关键词召回；`KnowledgeService.search` 读取活动索引，不能直接用于第四期固定召回；
- 当前没有测试点树、用例 revision、数据需求、覆盖审计或不可变用例集对象；
- 当前人工处置只覆盖 Finding，不具备树/用例 ETag 和审核 revision 绑定；
- 当前前端 `page=design` 表示技术方案评审，第四期必须使用新的页面键和独立状态；
- 当前无 Excel 生成依赖和机器可读测试用例 Schema；
- JSON Store 只能作为开发兼容路径，不能证明并行、租约和恢复语义。

### 3.3 实施原则

1. 复用运行算法，不复用错误的业务表和结果协议；
2. 平台 DAG 基础设施通用化，第四期业务语义保持独立；
3. 运行时固定所有会影响结果的输入和配置，不在节点执行时读取 `active/latest`；
4. 模型提交语义和输入内引用，服务端生成正式 ID、关系、Hash 与统计；
5. Agent 候选、当前人工草稿、审核决定和发布版本分层持久化；
6. 结构化机器契约是事实源，Markdown 和 Excel 只做投影；
7. 所有修改追加保存，任何重试、修订和发布均不覆盖历史；
8. 语义阻塞与系统失败分开表示，不能把待确认项伪装成执行异常。

---

## 4. 核心术语

| 术语 | 技术含义 |
|---|---|
| Workflow Definition | 服务端代码登记、版本化并计算 Hash 的只读 DAG 定义，用户和 Agent 不能修改。 |
| Workflow Run | 一次固定业务输入、拓扑和 Agent 配置的执行实例。 |
| Workflow Node Run | Agent、服务端确定性阶段或人工门禁节点的一次状态实例。 |
| Agent Task Attempt | Agent 节点的一次独立执行尝试，拥有 session、execution、租约和输出。 |
| Handoff Artifact | 上游校验后冻结、下游按 Hash 读取的不可变结构化产物。 |
| Basis Snapshot | 评审基线或知识资产主依据的不可变快照。 |
| Retrieval Snapshot | 固定召回范围、配置、查询和结果；关闭召回时也是非空记录。 |
| Historical Case Snapshot | 用户显式选择的历史结构化用例或固定文本的独立快照。 |
| Gate Decision | 对范围、测试点树或其他门禁的追加式人工决定。 |
| Candidate Publication | 四 Agent 及服务端审计通过后，原子保存 revision 0 候选；不是正式用例集发布。 |
| TestCaseSetVersion | 人工审核、当前审计和发布门禁全部通过后的不可变正式资产。 |
| Stale | 产物仍可查看，但其输入 Hash 已不再匹配当前投影，不得用于发布。 |

---

## 5. 架构决策

### 5.1 ADR-401：增加服务端定义的通用 DAG 运行层

新增通用 `WorkflowDefinitionRegistry`、Workflow Run、Node Run、Task Job、Handoff Artifact 和 Gate Decision 基础设施。第四期只登记 `test-design-workflow/v1`，不提供通用 DAG UI 或 API。

原因：第四期明确需要节点依赖、并行、门禁、重试和交接。继续为每个 Agent 新建一张单 Job 表会把依赖和恢复规则散落到业务服务中；允许用户编辑 DAG 又超出本期范围并扩大权限面。

### 5.2 ADR-402：业务数据使用第四期独立表

`test_designs`、依据快照、测试点、用例、数据需求、覆盖审计和用例集版本使用独立表。通用 Workflow 表只持有调度信息和业务对象引用，不保存第四期正式语义。

原因：避免通用运行层依赖 `basisMode`、测试树和用例审核细节，也避免继续扩张 Phase 2/3 的 JSONB Run 行。

### 5.3 ADR-403：TestDesign 固定逻辑输入，WorkflowRun 固定执行输入

`TestDesign` 创建时固定：

- `projectVersionId`；
- `basisMode`；
- 对应分支的主依据 ID；
- 用户测试目标、包含/排除范围和历史用例选择。

替换主依据或切换 `basisMode` 必须新建 `TestDesign`。`WorkflowRun` 在此基础上进一步固定正文、Hash、索引、召回配置、历史内容、DAG、四个 Agent 发布版本、模型、工具和限制。全部重跑在同一 `TestDesign` 下创建新 Run，重新校验相同显式选择并使用当时生效的 Agent 配置。

### 5.4 ADR-404：知识主依据完整投递，知识增强固定召回

`knowledge_assets` 主依据必须完整投递全部所选固定正文。知识增强只负责补充上下文，不能用 Top-K 替代主依据理解。

新增 `FixedKnowledgeRetrievalService`：

- `selected_assets` 从指定 AssetVersion 的固定 Chunk 中检索；
- `fixed_index` 只查询指定 IndexVersion，并叠加固定 AssetVersion/路径过滤；
- 检索配置、Embedding 模型、查询、结果和内容 Hash 全部进入快照；
- 不调用会解析 `activeIndexVersionId` 的 `KnowledgeService.search`；
- `disabled` 不调用 Embedding 或检索服务，直接写规范空快照。

### 5.5 ADR-405：四 Agent 与五阶段不是一一对应

第四期固定四个 Agent：

- `test-analysis`；
- `functional-test-design`；
- `non-functional-test-design`；
- `test-case-synthesis`。

测试数据需求由综合 Agent 在同一任务中第二次结构化提交；测试点树归并与覆盖审计由服务端确定性处理。人工范围确认和树批准是门禁。页面显示五阶段，但不能把门禁或服务端阶段伪装成 Agent。

### 5.6 ADR-406：模型不拥有正式引用和覆盖

模型只能引用本节点输入包内的临时 Ref 或冻结对象 Ref。以下字段一律由服务端生成或验证：

- 数据库 ID、`KBP-*`、`nodeId`、`caseId`、数据需求 ID；
- AssetVersion、Chunk、locator 和内容 Hash；
- 树 revision/version、用例 revision 和 ETag；
- BasisRelation、CoverageRelation、ReuseRelation；
- 覆盖数量、比例、发布阻塞和发布版本号。

### 5.7 ADR-407：树、用例与审核全部追加保存

树编辑生成不可变 `TestPointTreeRevision`；批准生成不可变 `TestPointTreeVersion`。用例保存生成不可变 `TestCaseRevision`；审核决定绑定明确 revision。任何新 revision 都使旧批准或审核失效，并触发覆盖审计过期。

### 5.8 ADR-408：覆盖审计是服务端可复现计算

`CoverageAuditor` 从数据库当前关系和规范化内容计算审计结果。综合 Agent 的遗漏/重复建议只作为输入提示，不进入正式统计。审计输入包含依据、召回、树、用例 revision 集合和数据需求 Hash，任一变化都使结果 `stale`。

### 5.9 ADR-409：候选成功、人工审核与正式发布分离

- Workflow `succeeded`：固定 DAG 完成，revision 0 候选原子保存且初始审计无 blocker；
- 用例 `approved`：人工审核了某个明确 revision；
- `TestCaseSetVersion` 发布：当前全部用例 approved + ready，审计仍 valid 且 Hash 相等，人工执行发布。

运行成功后人工编辑不会改写历史 Workflow 终态，但会让当前用例审核和审计失效，直到重新审核和重新审计。

### 5.10 ADR-410：只读 Agent 权限由服务端硬限制

第四期 Agent 的 Toolset 只包含固定输入读取、固定召回查询计划和阶段提交工具。即使资源目录登记了脚本、网络、浏览器、代码执行或写工具，发布校验和运行时都拒绝绑定。Skill 的脚本/网络派生权限同样计入禁止集合。

### 5.11 ADR-411：固定来源内容拥有独立保留引用

新增内容寻址的 `frozen_contents` 与所有者引用。Basis、Retrieval 和 Historical Snapshot 按 SHA-256 引用独立冻结正文/结构化内容。源资产归档、活动版本切换或允许删除后，已创建运行和已发布用例仍能读取冻结摘要和比较内容。

### 5.12 ADR-412：Excel 在服务端从规范 JSON 生成

Excel 不由前端拼接，也不从 Markdown 反解析。实现时引入经过依赖审查并由 `package-lock.json` 固定的 ExcelJS，服务端从指定 `TestCaseSetVersion` 生成固定工作表；若依赖审查不通过则替换为等价受维护库，不手写 XLSX ZIP/XML。

---

## 6. 总体架构

### 6.1 逻辑架构

```text
┌──────────────────────────── React / Vite ─────────────────────────────┐
│ 创建页 │ 工作流 │ 测试点树 │ 用例编辑 │ 数据 │ 覆盖 │ 审核 │ 发布   │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ HTTP JSON / SSE-poll / files
┌────────────────────────────────▼──────────────────────────────────────┐
│ API + Access Control                                                  │
│ projectVersion + testDesign + workflowRun 归属、ETag、幂等、脱敏      │
└───────────────┬──────────────────┬──────────────────┬─────────────────┘
                │                  │                  │
┌───────────────▼────────┐ ┌───────▼────────┐ ┌──────▼────────────────┐
│ Test Design Service    │ │ Edit/Review    │ │ Export/Publish        │
│ 创建、快照、运行、取消 │ │ Tree/Case/Data │ │ JSON/MD/XLSX/Asset    │
└───────────────┬────────┘ └───────┬────────┘ └──────┬────────────────┘
                └──────────────────┼──────────────────┘
                                   ▼
┌──────────────────────── PostgreSQL + Frozen Content ─────────────────┐
│ Workflow │ Jobs │ Snapshots │ Artifacts │ Trees │ Cases │ Audit │ Set │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │ claim / heartbeat / fence
┌────────────────────────────────▼──────────────────────────────────────┐
│ Worker + Workflow Scheduler                                           │
│ 解锁节点 -> Agent/Service Handler -> 校验 -> 冻结交接 -> 推进 DAG      │
└────────────┬───────────────────┬─────────────────────┬────────────────┘
             │                   │                     │
     ┌───────▼────────┐  ┌───────▼──────────┐  ┌──────▼──────────────┐
     │ Pi Agent Runtime│  │ Fixed Retrieval  │  │ Validator/Auditor   │
     │ 四个独立 session│  │ 固定资产/索引     │  │ Schema/关系/覆盖     │
     └───────┬────────┘  └──────────────────┘  └─────────────────────┘
             ▼
       Model Providers
```

### 6.2 分层职责

| 层 | 负责 | 不负责 |
|---|---|---|
| Frontend | 显式路由、编辑、门禁、审核、Diff、筛选和状态展示 | 生成正式 ID、计算覆盖、模拟进度 |
| HTTP | 认证、授权、归属、DTO、幂等、ETag、错误映射 | 直接等待模型长任务 |
| Application | 快照、业务状态机、失效传播、原子发布 | 自由改变 DAG 或绕过 Validator |
| Workflow Scheduler | 依赖、并行、门禁、任务解锁、重试和取消传播 | 理解测试业务内容 |
| Worker | 领取、心跳、执行 Handler、fencing 收敛 | 决定人工批准或正式发布 |
| Agent Runtime | 节点内模型/工具循环、公开事件和取消 | 决定业务成功、覆盖或正式引用 |
| Retrieval | 固定语料内查询与快照 | 使用 active/latest 或扩大 allowlist |
| Validator/Auditor | Schema、引用、Hash、关系、重复和覆盖计算 | 接受模型自报统计 |
| Store | 事务、追加写、租约、分页、窄查询 | 页面高频路径全库 snapshot |

### 6.3 部署拓扑

```text
Browser -> Vite/静态前端
        -> API -> PostgreSQL
Worker --------> PostgreSQL
Worker --------> 模型 Provider
Worker --------> 固定知识读取与检索运行时
API -----------> 冻结内容存储 / 报告生成
```

生产验收只接受 PostgreSQL + 独立 Worker。JSON Store 可以实现单进程兼容，但必须使用同一 Validator、Hash、状态机和 API，且不得作为并行、租约、崩溃恢复和容量验收依据。

---

## 7. 固定工作流设计

### 7.1 Workflow Definition

`WorkflowDefinitionRegistry` 内置 `test-design-workflow/v1`：

| Node Key | 类型 | 依赖 | Handler/Agent | 产物 |
|---|---|---|---|---|
| `freeze_inputs` | service | 无 | `FreezeInputsHandler` | 三类 Snapshot 与投递计划 |
| `test_analysis` | agent | `freeze_inputs` | `TestAnalysisAgent` | 分析检查点、知识基线、召回快照 |
| `scope_gate` | gate | `test_analysis` | 人工 | 已批准分析检查点 |
| `functional_design` | agent | `scope_gate` | `FunctionalTestDesignAgent` | 功能测试点候选 |
| `non_functional_design` | agent | `scope_gate` | `NonFunctionalTestDesignAgent` | 四维非功能候选 |
| `merge_test_point_tree` | service | 两个设计节点 | `TestPointTreeMerger` | Tree Draft revision 0 |
| `tree_gate` | gate | `merge_test_point_tree` | 人工 | 不可变 Tree Version |
| `synthesize_cases` | agent | `tree_gate` | `TestCaseSynthesisAgent` | 用例候选、数据需求候选 |
| `coverage_audit` | service | `synthesize_cases` | `CoverageAuditor` + `CandidatePublisher` | 审计结果；无 blocker 时在同一事务发布 Case revision 0 和数据集合 |

页面五阶段映射：

| 产品阶段 | 工作流节点 |
|---|---|
| 依据解构与知识召回 | `freeze_inputs`、`test_analysis`、`scope_gate` |
| 测试点智能发散 | 两个设计节点、树归并、`tree_gate` |
| 测试用例具象化 | `synthesize_cases` 的第一产物 |
| 测试数据资产定义 | `synthesize_cases` 的第二产物及服务端规范化 |
| 覆盖反向审计 | `coverage_audit`，内部完成审计与候选原子发布 |

`coverage_audit` 在事务外只执行无副作用计算，随后在一个数据库事务中重新锁定 Run、复核全部输入 Hash、写入 Audit，并在无 blocker 时同时写入 Case revision 0、数据需求集合和节点终态。不得先把 Audit 节点标成成功，再由另一个可失败节点补写候选。

### 7.2 调度事务

每次节点完成后，Scheduler 在一个数据库事务中：

1. `SELECT ... FOR UPDATE` 锁定 Workflow Run；
2. 校验当前 task run 的 run token、fencing token 和合法状态；
3. 校验输出 Schema 与全部上游 Hash；
4. 追加不可变 Handoff Artifact；
5. 将当前 Node Run 置为终态；
6. 找出依赖全部满足且门禁已批准的后继节点；
7. 为可执行节点创建 Node Run/Job，使用唯一键防止重复入队；
8. 从持久化节点计算 Workflow 状态和阶段；
9. 提交后发送 `NOTIFY smarthub_jobs`。

唯一键至少包括 `(workflow_run_id, node_key, generation, attempt)`。`generation` 在范围修订、树新批准版本或重新具象化时递增，避免新旧产物串接。

### 7.3 并行和公平性

- 功能与非功能设计在范围门禁批准后同时入队；
- `SMARTHUB_TEST_DESIGN_NODE_CONCURRENCY` 限制单 Workflow 并发，默认 2；
- `SMARTHUB_WORKER_CONCURRENCY` 继续限制进程总并发；
- Worker 将知识、需求评审、技术方案和 Workflow Job 注册为 Handler，并使用轮转游标或加权公平领取；
- 禁止沿用当前固定“技术方案 -> 需求评审 -> 知识任务”的永久优先顺序后简单追加第四期，否则持续流量下会饥饿；
- 同一数据库连接上的查询保持顺序执行，不对单个 `PoolClient` 发起并发 query。

### 7.4 门禁

Gate Node 自身不创建 Worker Job。API 追加 `GateDecision` 后调用 Scheduler：

- `approved`：冻结目标产物并解锁后继；
- `rejected`：保持 `waiting_approval`，要求显式修订；
- `needs_revision`：创建新 generation 的上游尝试，不自动沿用旧批准；
- 超时只产生提醒和指标，不自动批准或失败。

范围门禁允许批量接受合法知识基线项和历史处置，只强制逐条处理冲突、来源歧义、缺少 oracle 与高风险假设。树门禁必须绑定明确 tree revision。

### 7.5 Workflow 状态机

```text
queued -> running -> waiting_approval -> running -> succeeded
   |         |              |             |
   |         +------------> failed <------+  仅系统/不可恢复协议失败
   |         |              |
   +---------+--------------+-----------> cancelled
```

规则：

- `waiting_approval` 可表示范围门禁、树门禁或覆盖 blocker 待处理，详情用 `waitReason` 区分；
- `failed` 只表示节点执行、固定输入、协议或基础设施失败，不用来表示正常待确认；
- `succeeded` 需要四个 Agent 的合法成功尝试、两个批准门禁、完整交接链和无 blocker 的初始审计；
- 取消请求先写 `cancel_requested_at` 并停止创建新节点，再通过数据库通知和 AbortSignal 终止运行节点；
- 取消、失租约或超时后的迟到结果只能记录为 `discarded_late_result` 事件。

### 7.6 恢复操作

| 操作 | 技术行为 | 不变内容 |
|---|---|---|
| 修订测试范围 | 同一 Run、新 analysis generation、新 Agent task attempt；重用固定 Basis/Historical/Retrieval Snapshot | 主依据、召回结果、历史输入 |
| 重新执行失败设计节点 | 只为失败 node key 创建新 attempt | 成功并通过 Hash 复核的另一分支 |
| 修订测试点树 | 新 TreeRevision；旧批准、下游当前投影和审计 stale | 旧树、旧候选、人工修订历史 |
| 重新具象化用例 | 指定新 TreeVersion，创建新 synthesis generation | 依据、分析、专项原始产物 |
| 全部重跑 | 新 `workflowRunId`，重新校验 TestDesign 的显式输入并固定当前四 Agent 版本 | 原 TestDesign 的 `basisMode` 和逻辑选择 |

这些动作使用独立 API，不提供含糊的通用“重试”按钮。

---

## 8. 代码模块设计

### 8.1 新增通用工作流模块

| 建议路径 | 职责 |
|---|---|
| `server/workflow/definition-registry.ts` | 只读 Workflow Definition 登记、拓扑校验和 Hash。 |
| `server/workflow/scheduler.ts` | 依赖满足、Job 解锁、门禁、终态计算和取消传播。 |
| `server/workflow/worker-handler.ts` | Workflow Job 领取后的 Handler 分派。 |
| `server/workflow/handoff-validator.ts` | Artifact Schema、阶段、输入/输出 Hash 校验。 |
| `server/domain/workflow-types.ts` | Run、Node、Job、Artifact、Gate 和状态类型。 |

### 8.2 新增第四期服务端模块

| 建议路径 | 职责 |
|---|---|
| `server/domain/test-design-types.ts` | TestDesign、Snapshot、树、用例、数据、审计和发布 DTO。 |
| `server/application/test-design-service.ts` | 创建、输入校验、运行、查询、取消与恢复动作。 |
| `server/application/test-design-edit-service.ts` | 树/用例/数据 revision、Diff、ETag 和失效传播。 |
| `server/application/test-design-review-service.ts` | 用例逐条/批量审核和乐观锁。 |
| `server/application/test-case-set-service.ts` | 发布门禁、不可变版本、导出与知识资产投影。 |
| `server/agent/test-design-context-assembler.ts` | 两种模式输入包、分段、预算与投递证明。 |
| `server/agent/test-design-result-validator.ts` | 四类 Agent Submission 校验和规范化。 |
| `server/agent/knowledge-basis-resolver.ts` | `sourceTexts` 固定定位、KBP 和冲突状态。 |
| `server/application/fixed-knowledge-retrieval-service.ts` | 固定资产/索引检索与 Retrieval Snapshot。 |
| `server/application/test-point-tree-service.ts` | 专项归并、稳定节点、树操作和批准版本。 |
| `server/application/coverage-auditor.ts` | 覆盖、孤立、重复、oracle、数据和 Hash 审计。 |
| `server/application/test-design-report-service.ts` | JSON、Markdown 和 Excel 投影。 |
| `server/tools/test-design-tools.ts` | 节点只读/提交工具注册。 |

### 8.3 修改现有模块

| 路径 | 修改点 |
|---|---|
| `server/domain/agent-types.ts` | 增加四 Agent key/type、`test_design` model scene 和协议联合类型。 |
| `server/domain/types.ts` | 增加四个 AgentConfiguration key；避免继续手写长三元映射，改为登记表。 |
| `server/application/agent-configuration-service.ts` | 四个独立草稿/发布状态、必需 Tool、只读能力校验。 |
| `server/agent/agents-config.json` | 增加四个内置定义和 Prompt 引用。 |
| `server/tools/built-in-tools-config.json` | 登记第四期只读/提交工具及风险。 |
| `server/tools/capability-loader.ts` | 发布时硬拒绝第四期禁止能力。 |
| `server/infrastructure/store.ts` | Workflow 与第四期窄查询/事务接口。 |
| `server/infrastructure/postgres-store.ts` | 新表映射、claim/heartbeat/fence、分页和审计聚合。 |
| `server/infrastructure/migrations.ts` | 迁移 15 起新增第四期表、约束和索引。 |
| `server/worker.ts` | Handler Registry、公平领取和 Workflow Job 执行。 |
| `server/http/server.ts` | 嵌套路由、权限、ETag、幂等、文件响应和错误码。 |
| `src/App.tsx` | 新 `page=test-design`、懒加载页面和四 Agent 配置选项。 |

### 8.4 前端模块

| 建议路径 | 职责 |
|---|---|
| `src/test-design-api.ts` | DTO、分页、ETag、运行/编辑/审核/导出 API。 |
| `src/TestDesignPage.tsx` | 创建页与三栏工作台外壳。 |
| `src/test-design/TestDesignWorkflowView.tsx` | 五阶段、四 Agent、门禁和恢复操作。 |
| `src/test-design/TestPointTreeEditor.tsx` | 增删移动拆并、键盘操作、revision 与 Diff。 |
| `src/test-design/TestCaseEditor.tsx` | `test-case/v1` 结构化表单与 UI/API 分支。 |
| `src/test-design/TestDataView.tsx` | 数据需求筛选、详情和 readiness。 |
| `src/test-design/CoverageAuditView.tsx` | 依据 -> 测试点 -> 用例双向矩阵。 |
| `src/test-design/HistoricalCaseDiff.tsx` | 冻结来源、当前 revision 和字段 Diff。 |
| `src/test-design/test-design-state.ts` | 显式路由恢复、轮询和本地未提交编辑状态。 |

### 8.5 核心接口

```ts
interface WorkflowScheduler {
  start(runId: string): Promise<void>
  completeNode(input: CompleteNodeInput): Promise<void>
  applyGateDecision(input: ApplyGateDecisionInput): Promise<void>
  cancel(runId: string, actor: Principal): Promise<void>
  resumeRecoverableRuns(limit: number): Promise<number>
}

interface TestDesignService {
  createDesign(input: CreateTestDesignInput, actor: Principal): Promise<TestDesign>
  createRun(input: CreateTestDesignRunInput, actor: Principal): Promise<TestDesignWorkflowRun>
  getRun(scope: TestDesignRunScope): Promise<TestDesignWorkflowRunDetail>
  cancelRun(scope: TestDesignRunScope, actor: Principal): Promise<void>
  fullRerun(scope: TestDesignRunScope, actor: Principal): Promise<TestDesignWorkflowRun>
}

interface CoverageAuditor {
  audit(input: CoverageAuditInput): Promise<CoverageAuditResult>
}

interface TestCaseSetService {
  publish(input: PublishTestCaseSetInput, actor: Principal): Promise<TestCaseSetVersion>
  export(versionId: string, format: 'json' | 'markdown' | 'xlsx'): Promise<ExportPayload>
}
```

---

## 9. Agent 设计

### 9.1 Agent 定义

| 配置 Key | Agent Key | Agent Type | 结果协议 |
|---|---|---|---|
| `testAnalysis` | `test-analysis` | `test_analysis` | `test-analysis/v1` |
| `functionalTestDesign` | `functional-test-design` | `functional_test_design` | `functional-test-design/v1` |
| `nonFunctionalTestDesign` | `non-functional-test-design` | `non_functional_test_design` | `non-functional-test-design/v1` |
| `testCaseSynthesis` | `test-case-synthesis` | `test_case_synthesis` | `test-case-synthesis/v1` + `test-data-requirement-set/v1` |

四者使用 `modelScene=test_design`，各自拥有独立模型路由、Prompt、Toolset、限制、配置版本和 Pi session。不能通过修改 Prompt 让同一 AgentDefinition 临时兼任另一角色。

### 9.2 Toolset

| Agent | 必需 Tool | 说明 |
|---|---|---|
| TestAnalysis | `test_design.input.read` | 读取本节点固定输入包/确定性分段。 |
| TestAnalysis | `test_analysis.submit_query_plan` | 仅增强开启且快照未冻结时调用一次。 |
| TestAnalysis | `test_analysis.submit_result` | 提交依据解构、历史适用性和知识线索。 |
| Functional | `test_design.analysis_checkpoint.read` | 读取已批准范围检查点。 |
| Functional | `functional_test_design.submit_result` | 提交功能树候选。 |
| NonFunctional | `test_design.analysis_checkpoint.read` | 读取同一已批准检查点。 |
| NonFunctional | `non_functional_test_design.submit_result` | 提交性能/稳定性/兼容性/安全四分区。 |
| Synthesis | `test_design.approved_tree.read` | 读取指定不可变 TreeVersion。 |
| Synthesis | `test_case_synthesis.submit_result` | 先提交用例候选并冻结候选 Hash。 |
| Synthesis | `test_data_requirements.submit_result` | 再引用已冻结候选临时 Ref 提交数据需求。 |

结果提交工具每个阶段独立保留 3 次修正额度。`submit_query_plan` 不计入正式结果提交保留。重复工具调用、参数大小和总调用次数沿用 Tool Runtime 治理。

### 9.3 召回工具循环

增强开启时，分析节点执行顺序为：

1. 模型读取固定主依据与历史快照目录；
2. 调用 `test_analysis.submit_query_plan` 提交去重特征和查询意图；
3. 服务端校验数量、长度、allowlist 和配置 Hash；
4. `FixedKnowledgeRetrievalService` 执行检索并冻结 Retrieval Snapshot；
5. 同一 Agent session 获得分类后的固定召回结果；
6. 模型调用 `test_analysis.submit_result`；
7. 节点重试时直接注入已冻结 Retrieval Snapshot，不再次开放查询计划工具。

`disabled` 模式跳过 2～5，服务端预先创建规范空快照。

### 9.4 上下文预算

每个 Agent 的 `InputPlan` 使用当前已选模型的 context window 计算：

```text
inputBudget = contextWindow
  - systemPromptTokens
  - toolSchemaTokens
  - reservedOutputTokens
  - correctionReserveTokens
  - safetyMarginTokens
```

- 主依据、批准检查点和批准树均为强制输入；
- 正常规模使用 `full_context`；
- 超预算按资产顺序、标题、Chunk 和树分支做确定性分段；
- 每批保存内容 Hash、顺序和覆盖范围；
- 最终提交前必须完成全局归并；
- 不能通过截掉依据、树节点或历史选择来满足预算；
- 超出配置的最大批数时明确失败并提示缩小输入范围。

### 9.5 停止条件

Pi `agent_end` 不等于节点成功。节点成功需要：

- 当前协议的必需提交工具完成；
- Submission 通过 TypeBox/业务 Validator；
- 输入 Ref、阶段和全部 Hash 一致；
- InputDeliveryManifest 完整；
- 没有未消费的修正反馈；
- 当前 run token 和 fencing token 仍有效；
- 输出 Artifact 在事务中冻结成功。

---

## 10. 固定输入与快照

### 10.1 创建请求判别联合

```ts
type CreateTestDesignInput = Common & (
  | {
      basisMode: 'review_baseline'
      sourceReviewRunId: string
      sourceTechnicalSolutionRunId: string
    }
  | {
      basisMode: 'knowledge_assets'
      knowledgeAssetVersionIds: string[]
      includedScopes?: ScopeRule[]
      excludedScopes?: ScopeRule[]
      focusDimensions?: TestDimension[]
      userCoverageObjectives?: string[]
    }
) & {
  knowledgeAugmentation:
    | { mode: 'disabled' }
    | { mode: 'selected_assets'; assetVersionIds: string[] }
    | { mode: 'fixed_index'; indexVersionId: string; filters?: FixedIndexFilter }
  historicalCaseSelections?: HistoricalCaseSelection[]
}
```

服务端使用严格字段白名单。错误分支字段即使为 `null`、空数组或空字符串也拒绝，不能先宽松反序列化再丢弃未知字段。

### 10.2 review_baseline 快照

创建 Run 时事务性读取并复制：

- succeeded Phase 2 ReviewRun、正式需求点、Evidence、Finding 原始内容与当前处置投影；
- succeeded Phase 3 TechnicalSolutionReviewRun、正式方案要点、Evidence、Finding 与处置投影；
- Phase 3 `sourceReviewRunId` 必须等于所选 Phase 2 Run；
- 两个 Run 和 TestDesign 必须属于同一 `projectVersionId`；
- 上游结果 Schema 版本、结果规范 JSON Hash 和输入快照 Hash；
- 用户目标、范围和排除项。

上游后续处置或新 Run 只触发“可能过期”提示，不改变快照。

### 10.3 knowledge_assets 快照

每个所选 AssetVersion 固定：

- project、knowledgeBase、asset、assetVersion、逻辑路径和类型；
- `ready` 状态、内容 Hash、正文、Chunk 清单和 Chunk Hash；
- 配置/索引元数据、用户目标、范围和排除项；
- `KnowledgeInputPackage` 与 `InputDeliveryManifest`；
- 内容寻址的 frozen content 引用。

全部所选正文必须交付。没有任何可定位 `KnowledgeBasisItem`、投递不完整或关键冲突未处理时，范围门禁不能批准。

### 10.4 Retrieval Snapshot

字段至少包括：

```text
mode, corpusRef, indexVersionId?, assetVersionIds[], filters,
embeddingModelRef, retrievalConfigVersion, queryPlan,
queryPlanSha256, hits[], classification, createdAt, snapshotSha256
```

每个 hit 固定 `assetVersionId + chunkId + contentSha256 + score + rank + locator`。分类仅允许 `normative_reference`、`historical_defect`、`domain_practice`、`context_only`。分类不改变主依据类型。

规范空快照包含：

```json
{"mode":"disabled","assetVersionIds":[],"queryPlan":[],"hits":[],"canonicalVersion":"retrieval-snapshot/v1"}
```

其 `snapshotSha256` 不能为空。

### 10.5 Historical Case Snapshot

- 结构化来源固定 `testCaseSetVersionId + caseId[] + schemaVersion + canonical JSON + semanticSha256`；
- 资产来源固定 `test_case assetVersionId + locator + text + contentSha256`；
- 只允许同一 SmartHub 项目，允许其他项目版本；
- 不允许 latest、草稿、未批准/非 ready 结构化用例或失效定位；
- 同一 `test_case assetVersionId` 不能同时作为主依据和历史输入；
- Snapshot 自包含比较所需内容，不在后续重新搜索相似用例。

### 10.6 规范化与 Hash

新增共享 `canonical-json.ts`：

- 对象 Key 按 Unicode code point 升序；
- 数组保持业务顺序，集合字段在进入 canonicalizer 前按协议指定 Key 排序；
- `undefined` 不允许进入正式对象，缺省与显式 `null` 按 Schema 区分；
- 拒绝 `NaN`、`Infinity`、循环引用和未知字段；
- 字符串保持 UTF-8 内容，不做不可逆 trim；只有协议明确的展示字段先规范化；
- SHA-256 对 UTF-8 canonical JSON 字节计算并使用小写十六进制。

现有 `stableStringify` 可重构到该工具，但迁移必须保持 Phase 2/3 历史 Hash 的原算法读取兼容；旧对象不原地重算。

---

## 11. Agent 结果协议

### 11.1 TestAnalysis Submission

`test-analysis/v1` 至少包含：

- 范围摘要、目标、排除范围；
- entities、actors、terms、actions、rules、constraints、states/transitions、interfaces、oracles；
- 五类维度适用性；
- UI/API 入口适用性；
- Happy Path、关键判断和测试域；
- 历史用例逐条适用性与建议；
- risks、confirmationItems；
- 模式匹配的输入 Ref；
- knowledge 模式下的 `KnowledgeBasisItemCandidate.sourceTexts[]`。

KnowledgeBasis Resolver 只在固定主依据正文中定位连续原文。唯一定位后服务端生成 `KBP-*`、AssetVersion、Chunk、标题路径、行/字符范围和 Hash。无法定位或歧义候选进入 Finding/确认项，不生成正式 KBP。

### 11.2 功能设计 Submission

`functional-test-design/v1` 每个候选节点包含：

- 临时节点 Ref、临时 parent Ref；
- 标题、目标、优先级、适用性；
- `designTechniques[]` 及理由；
- UI/API 候选及理由；
- oracle、数据条件、风险、假设；
- Basis Ref、历史候选 Ref；
- duplicate/conflict hint。

Validator 检查 Happy Path、关键判断、等价类、边界、状态、异常、权限、并发/幂等和历史缺陷是否明确采用或说明不采用。

### 11.3 非功能设计 Submission

`non-functional-test-design/v1` 固定包含四个分区：

```text
performance, stability, compatibility, security
```

每个分区必须为 `applicable` 或 `not_applicable`。不适用必须给出依据和检查范围。任何数值阈值都必须引用冻结依据或已批准策略 Ref；缺少来源的确定数值拒绝，改为确认项和 `blocked_by_confirmation`。

### 11.4 Synthesis Submission

`test-case-synthesis/v1` 只能引用批准树中的 `testPointRef`。每个候选至少包含标题、目标、维度、`testMethod`、优先级、前置、步骤/逐步期望、检查点、清理、依赖、数据临时 Ref、Basis Ref、历史建议、自动化提示和执行就绪状态。

- `ui` 必须且只能包含 `uiSpec`；
- `api` 必须且只能包含 `apiSpec`；
- 数据、异步任务和集成结果只能作为 `verificationChecks`，不能成为第三种 testMethod；
- 零用例测试点或多测试点合并必须提交理由；
- 综合 Agent 不得创建树外节点。

### 11.5 Data Requirement Submission

`test-data-requirement-set/v1` 在用例候选 Hash 冻结后提交：

- 临时 data Ref、名称、entityType、featureTags；
- testPointRefs、caseCandidateRefs；
- fieldConstraints、relationships、quantity、initialState；
- preparationHint、sensitivity、isolation；
- resetAndCleanup、readiness 和原因。

不允许真实账号、Token、Cookie、API Key、身份证件或生产个人数据。秘密只用命名引用/占位符。

### 11.6 校验反馈

Validator 返回机器可修正的公开错误：

```json
{
  "code": "CASE_API_SPEC_REQUIRED",
  "path": "/cases/3/apiSpec",
  "message": "testMethod=api 时必须提供 apiSpec",
  "retryable": true
}
```

反馈不包含隐藏思维、服务端秘密或其他项目数据。超过阶段保留的提交次数后节点失败，不能把最后一个非法候选落库。

---

## 12. 测试点树设计

### 12.1 存储模型

测试点树传输与批准快照统一使用 `test-point-tree/v1`。规范存储不是一列可覆盖 JSON。稳定身份和版本内容分开：

- `test_point_trees`：逻辑树及当前 draft revision；
- `test_point_nodes`：稳定 `nodeId` 和所属逻辑树；
- `test_point_tree_revisions`：revision、parent revision、操作者、说明、Diff、tree hash；
- `test_point_node_revisions`：某 tree revision 下节点字段、parentId 和 sortKey；
- `test_point_tree_versions`：批准 revision 的不可变版本与 Hash；
- Basis/历史/专项来源使用独立关系表，不因移动节点而重写来源语义。

### 12.2 归并

`TestPointTreeMerger`：

1. 校验两分支临时树无循环、孤儿和重复 Ref；
2. 为每个候选分配稳定 nodeId；
3. 按维度/业务域构造根层级；
4. 使用规范标题、目标、依据集合、入口和 oracle 形成确定性 duplicate fingerprint；
5. 高度相似项建立 duplicate group，不自动删除；
6. 冲突项同时保留并建立 conflict relation；
7. 生成 revision 0、结构 Hash 和两个原始 Artifact 引用。

### 12.3 编辑操作

PATCH API 只接受结构化 operation：

```text
add, rename, update, move, split, merge, delete, mark_not_applicable, reorder
```

每个请求携带 `If-Match` 和操作说明。事务中校验：

- node/parent 属于同一树；
- 无父子循环；
- sortKey 唯一且稳定；
- 删除/合并后的 Basis、历史映射和下游影响可解释；
- 不能伪造服务端 nodeId；
- 已批准树编辑先产生新 draft revision，不修改 TreeVersion。

成功返回新 ETag：

```text
"tree:{treeId}:r{revision}:{treeSha256}"
```

### 12.4 批准与失效

批准绑定 tree revision 并生成 `TestPointTreeVersion`。已批准后任何新 revision：

- 不删除旧 TreeVersion；
- 当前 tree approval 变为 stale；
- 当前用例/数据/审计投影标记 stale；
- 综合节点不自动执行；
- 页面只提供明确“重新具象化用例”。

---

## 13. 测试用例、数据和审核

### 13.1 test-case/v1

规范对象至少包含需求文档 5.8 的全部字段，并使用严格联合：

```ts
type TestCaseV1 = CommonCase & (
  | { testMethod: 'ui'; uiSpec: UiSpec; apiSpec?: never }
  | { testMethod: 'api'; apiSpec: ApiSpec; uiSpec?: never }
)
```

`steps[]` 中每个稳定 step key 同时包含动作和本步骤期望；`dependencies[]` 发布前执行图循环检测；`basisRelations` 和历史来源由服务端从冻结 Ref 生成，客户端不能填写任意 ID。

### 13.2 Draft 与 Revision

- 候选发布为每条用例创建新 `caseId`、revision 0 和 Draft；
- revision 0 永久保存 AI/历史初始内容；
- PATCH 接受期望 revision、结构化字段和保存说明；
- Validator 通过后创建 revision N+1、字段 Diff 和 contentSha256；
- Draft 只指向当前 revision，不复制可变正文；
- 编辑 `unchanged` 历史复用用例后，事务中自动转为 `modified` 并生成 Diff；
- 新建、删除或修订用例都使审核与 CoverageAudit 失效。

用例 ETag：

```text
"case:{caseId}:r{revision}:{contentSha256}"
```

冲突返回 412 并包含当前 revision、ETag 和可安全展示的字段 Diff，不自动覆盖。

### 13.3 历史复用

| 操作 | 来源限制 | 结果 |
|---|---|---|
| 复用 | 结构化且语义 Hash 不变 | 新 caseId、revision 0、`unchanged` relation |
| 复制并修改 | 结构化历史用例 | 新 caseId、`modified`、字段 Diff 和摘要 |
| 参考生成草稿 | 固定 test_case 文本 | 新 caseId、`modified`，不能标为 unchanged |
| 废弃/冲突 | 任意历史候选 | 保留处置，不进入当前用例集 |

所有历史候选必须先映射到树节点。无法映射但确有价值时，用户先补树并批准新版本，再重新具象化或参考生成。

### 13.4 数据需求

数据需求使用逻辑集合 + 不可变集合版本：

- 综合节点生成初始 `TestDataRequirementSet`；
- 用户修改时创建新 Set revision 和 Hash；
- 关系以 `dataRequirementId -> testPoint/case` 独立保存；
- `blocked/needs_confirmation` 数据使关联用例不能为 ready；
- preparationHint 只描述未来准备策略，不触发任何外部操作。

### 13.5 审核状态机

```text
draft -> in_review -> approved
   ^          |         |
   |          +-> rejected
   +----------+-> needs_revision
```

- 审核动作追加保存并绑定 case revision；
- 批量审核在一个事务中为每条用例写独立 Action，任一目标 revision 冲突则整体拒绝；
- 新 CaseRevision 将当前状态恢复为 `draft`，旧 Action 继续可读；
- 普通编辑在 `in_review` 时锁定；`needs_revision` 后可编辑；
- 服务端使用 Principal 生成 actorId，客户端不能提交审核人。

### 13.6 Finding 与待确认项

`DesignFinding` 和 `ConfirmationItem` 保存 AI 初始内容，处置使用独立追加表，不 UPDATE 初始记录。投影状态至少包括 `open`、`confirmed`、`resolved`、`deferred`、`rejected`，每个 Action 携带 `expectedVersion`。

ConfirmationItem 额外保存：

- 缺少的决策类型，例如性能阈值、兼容版本、数据条件、范围或环境；
- `impactStage=analysis|tree|case|data|publication`；
- 受影响的冻结 Ref、树节点/候选 Ref；
- 是否为发布 blocker；
- 用户结构化决定、说明、actor 和时间；
- 决定形成的 `user_decision` Hash。

处置不会在原 Artifact 中就地填值。服务端按 impactStage 要求创建新分析 generation、新树 revision/批准版本、新综合 generation 或新审计；因此用户决定可追溯，也不会被错误展示为原始资料中的已确认事实。

---

## 14. 覆盖审计

### 14.1 审计输入

```text
basisSnapshotSha256
retrievalSnapshotSha256
testPointTreeVersionId + treeSha256
sorted {caseId, revision, contentSha256}[]
testDataRequirementSetVersionId + dataSha256
```

`auditedCaseRevisionSetSha256` 对按 caseId 升序的三元组集合计算。

### 14.2 校验顺序

1. 阶段和全部 Hash 一致；
2. TestCase/TestData Schema；
3. 树节点、数据和用例依赖归属；
4. 枚举与语义字段规范化；
5. UI/API 判别字段；
6. 模式匹配的 Basis 引用；
7. 步骤、期望、oracle 和 readiness；
8. 历史复用 Hash/Diff；
9. 重复、冲突和循环依赖；
10. 依据 -> 测试点 -> 用例及反向来源完整性；
11. 发布 blockers 和正式统计。

非法项不会分配正式发布 ID或计入成功统计。

### 14.3 覆盖分母

- `review_baseline`：范围内冻结需求点；方案要点作为关联和风险视图，不与需求点重复充当同一覆盖分母；
- `knowledge_assets`：范围门禁批准的 KnowledgeBasisItem + 用户覆盖目标；
- 文档数、Chunk 数、Agent 自报总数均不是覆盖分母；
- 页面和报告分别命名“评审基线覆盖”与“知识基线覆盖”。

每个目标状态为 `covered`、`partially_covered`、`not_covered`、`not_testable`、`needs_confirmation`。`covered` 必须至少存在合法树节点和用例；后两类必须有理由或确认项。

### 14.4 重复与自动合并

服务端先用确定性 fingerprint 建组，再可选使用固定模型/向量产生相似候选建议。正式审计记录建议算法和阈值。系统不得自动合并会丢失专项来源、严格 oracle、不同 testMethod 或不同 Basis 的用例；人工合并产生新 revision。

### 14.5 失效传播

以下任一事件将当前 `CoverageAuditResult.validity` 置为 `stale`：

- 树批准版本变化；
- 用例新增、删除或 current revision 变化；
- 数据需求集合变化；
- 当前用例审核集合变化导致发布集合 Hash 变化；
- 依据或召回 Hash 校验失败。

重新审核不能恢复审计，只能重新运行确定性 Auditor。审计历史不删除。

### 14.6 候选原子发布与正式用例集门禁

Synthesis Submission 使用临时候选 Ref。服务端先完成基础 Schema、输入 Ref 和模式校验，再为合法候选在事务内预分配 case/data ID；CoverageAuditor 对该规范集合计算 Hash。存在 blocker 时只保存 Audit、候选 Artifact 和临时 Ref，不落 `TestCaseDraft`，用户处置确认项后执行明确的重新具象化/审计流程。无 blocker 时 Audit、Case revision 0、Draft、数据集合、关系和 Workflow 成功终态在同一事务提交。

人工正式发布时再次锁定 TestDesign 和当前投影，并依次验证：

1. 当前树批准仍有效；
2. 所有非 tombstone 当前用例均为目标 revision 的 `approved + ready`；
3. 所有被引用数据需求均为 `ready`；
4. 用例依赖存在、无环且成员全部进入发布集合；
5. 当前 `approvedCaseRevisionSetSha256` 等于有效 Audit 的 `auditedCaseRevisionSetSha256`；
6. 当前数据需求 Hash、Basis/Retrieval/Tree Hash 与 Audit 完全相等；
7. Finding/Confirmation 和 Audit blocker 数量为零；
8. `test-case-set/v1` 全量校验通过。

随后按 TestDesign 锁定并递增版本号，写 `test_case_set_versions`、成员、关系和规范 JSON。相同 contentSha256 幂等返回已有版本；不同内容必须创建新版本。事务提交后再异步创建 `test_case` 知识资产投影，默认逻辑路径为 `版本文档/{项目版本名}/测试设计/`。投影失败不回滚正式用例集。

---

## 15. 数据模型

### 15.1 实体关系

```text
TestDesign 1---n WorkflowRun 1---n WorkflowNodeRun 1---n TaskJob
                        |                   |
                        |                   +---n HandoffArtifact
                        +---1 BasisSnapshot
                        +---1 RetrievalSnapshot
                        +---0..1 HistoricalSnapshot
                        +---n GateDecision
                        +---1 TestPointTree ---n TreeRevision ---0..1 TreeVersion
                        +---n TestCase ---n CaseRevision ---n ReviewAction
                        +---n TestDataRequirementSetVersion
                        +---n CoverageAuditResult
                        +---n TestCaseSetVersion
```

### 15.2 通用 Workflow 表

#### `workflow_runs`

关键列：`id`、`workflow_type`、`definition_version`、`topology_sha256`、`project_version_id`、`domain_type`、`domain_id`、`status`、`current_stage`、`wait_reason`、`generation`、`idempotency_key`、`cancel_requested_at`、`created_by`、起止时间、`error_code`、`error_summary`、`data jsonb`。

约束/索引：

- `(project_version_id, domain_type, domain_id, created_at desc)`；
- 运行中的相同 `(domain_id, idempotency_key)` 唯一；
- status CHECK；
- 活动运行部分索引；
- projectVersion 外键删除策略由项目版本生命周期服务显式处理。

#### `workflow_node_runs`

关键列：`id`、`workflow_run_id`、`node_key`、`node_kind`、`generation`、`attempt`、`status`、依赖、输入/输出 Artifact、Agent/配置/模型/执行 Ref、开始结束时间、错误和 `data`。

唯一键：`(workflow_run_id, node_key, generation, attempt)`。

#### `workflow_task_jobs`

关键列：`node_run_id`、`status`、`available_at`、`attempt_count`、`max_attempts`、`lease_owner`、`run_token uuid`、`fencing_token bigint`、`lease_expires_at`、`cancel_requested_at`、错误和时间。

索引沿用现有 Job 模式：queued claim、running lease expiration；完成写入必须同时匹配 node_run、run_token 和 fencing_token。

#### `workflow_handoff_artifacts`

关键列：`id`、`workflow_run_id`、`node_run_id`、`artifact_type`、`schema_version`、`basis_mode`、各输入 Hash、`content_sha256`、`content jsonb`、`validation_status`、`created_at`。Artifact 不 UPDATE。

#### `workflow_gate_decisions`

关键列：`id`、`workflow_run_id`、`gate_key`、`target_artifact_id`、`target_revision`、`decision`、`comment`、`actor_id`、`expected_version`、`created_at`。使用 `(run, gate, version)` 追加并发控制。

### 15.3 冻结内容和快照

#### `frozen_contents`

`content_sha256` 主键、`media_type`、`byte_length`、`content text/bytea`、`created_at`。内容按 Hash 去重且不可更新。

#### `frozen_content_refs`

`owner_type`、`owner_id`、`role`、`ordinal`、`content_sha256`、locator metadata，联合主键。只有无任何 Ref 时维护任务才可物理清理内容。

#### 第四期 Snapshot 表

- `test_design_basis_snapshots`；
- `test_design_retrieval_snapshots`；
- `test_design_historical_case_snapshots`；
- `test_design_snapshot_items`，保存模式化项目、资产、Chunk、上游对象和 Hash 索引。

Snapshot 主体 JSONB 保留完整版本化协议，常用归属、模式、状态和 Hash 同时使用列与约束，不只藏在 JSONB。

### 15.4 TestDesign 和树表

- `test_designs`：ID、projectVersion、name、objective、basisMode、逻辑输入 Hash、createdBy/time；
- `test_point_trees`；
- `test_point_nodes`；
- `test_point_tree_revisions`；
- `test_point_node_revisions`；
- `test_point_tree_versions`；
- `test_point_source_relations`，保存 functional/non-functional 原始候选；
- `test_point_historical_mappings`。

树节点版本表对 `(tree_revision_id, parent_id, sort_key)` 建索引；应用层和递归 CTE 双重校验循环。

### 15.5 用例和数据表

- `test_cases`：稳定 caseId、run/tree 归属、origin、currentRevision、生命周期状态；
- `test_case_revisions`：revision、规范内容、content/semantic Hash、Diff、editor、reason、time；
- `test_case_review_actions`：目标 revision、前后状态、决定、actor、time；
- `test_case_reuse_relations`：来源 Snapshot、source case/locator、mode、源/当前 Hash、Diff、摘要；
- `test_case_dependencies`：源/目标 case 与目标 revision set；
- `test_data_requirement_sets` 与 `test_data_requirement_set_versions`；
- `test_data_requirements` 与 point/case 关系表。

`test_case_revisions` 唯一 `(case_id, revision)`；Draft 当前指针更新和新 Revision INSERT 必须在同一事务。

### 15.6 Basis、Coverage、Finding 和发布表

- `test_design_basis_relations`：subject kind/id/revision、basisMode、basis type、冻结 Ref 或推导说明；
- `test_design_coverage_relations`：target type/ref、point/case、status、reason、auditId；
- `test_design_findings`；
- `test_design_confirmation_items`；
- `test_design_finding_actions` 与 `test_design_confirmation_actions`，保存追加式处置、结构化确认值、影响阶段、actor 和版本；
- `test_design_coverage_audits`：输入 Hash、统计、问题、blockers、valid/stale；
- `test_case_set_versions`：版本、所有快照/树/数据/审计 Hash、规范 JSON、contentSha、发布人/time、投影状态；
- `test_case_set_members`：version、case、case revision、ordinal；
- `test_case_asset_publications`：用例集版本、目标逻辑路径、contentSha、task/status/error。

### 15.7 删除与保留

- 活动 WorkflowRun 阻止项目版本物理删除，必须先取消并收敛；
- open 项目版本删除时级联第四期逻辑对象和业务关系；
- frozen content 仅在全部 owner Ref 删除后由维护任务清理；
- 发布用例集随项目版本删除遵循现有不可逆级联确认，但不能级联修改其历史来源项目版本；
- 删除当前草稿不删除 Historical Snapshot 或源 TestCaseSetVersion；
- locked/archived 项目版本只读。

### 15.8 迁移顺序

建议在现有迁移 14 后分四次实施：

| 迁移 | 内容 |
|---|---|
| 15 | Workflow Run/Node/Job/Artifact/Gate 与公平领取索引 |
| 16 | TestDesign、三类 Snapshot、frozen content、KnowledgeBasisItem |
| 17 | 测试点树、用例 revision、数据需求、来源/历史关系 |
| 18 | 覆盖审计、用例集版本、导出/知识资产投影状态 |

每次迁移使用现有 checksum 和 advisory lock；先建表/索引，再发布读取兼容代码，再开放写入。禁止修改已应用迁移 1～14。

---

## 16. API 设计

### 16.1 通用规则

- 基础路径 `/api/project-versions/:projectVersionId/test-designs`；
- Run 详情始终嵌套 `testDesignId + workflowRunId`；
- 创建/恢复/发布使用 `Idempotency-Key`；
- 树和用例修改使用 `If-Match`，响应返回 `ETag`；
- 只有 `open` 项目版本允许创建 Run、修订、审核和发布；`locked/archived` 只允许读取历史与下载既有发布版本；
- 列表使用 cursor 分页，筛选在服务端执行；
- 业务错误使用稳定 `code`、公开 `message`、`details` 和 `requestId`；
- 不能定位固定来源时返回错误，不回退 latest；
- API 不返回模型隐藏思维、秘密、原始凭据或未脱敏 Tool 参数。

### 16.2 输入候选

```text
GET /inputs/review-baselines
GET /inputs/knowledge-assets
GET /inputs/fixed-indexes
GET /inputs/historical-case-sets
GET /inputs/historical-case-assets
GET /agent-readiness
```

候选 DTO 携带明确不可选原因，不只返回可选项。评审基线 API 只返回引用链一致的组合，服务端创建时仍再次校验。

### 16.3 TestDesign 与 Run

```text
POST /test-designs
GET  /test-designs?cursor=&basisMode=
GET  /test-designs/:testDesignId
POST /test-designs/:testDesignId/runs
GET  /test-designs/:testDesignId/runs
GET  /test-designs/:testDesignId/runs/:workflowRunId
POST /test-designs/:testDesignId/runs/:workflowRunId/cancel
```

创建 Run 同步执行归属、状态、Agent 就绪、固定 ID 和 Hash 前置检查，写 Snapshot/Job 后立即返回 202，不等待模型。

### 16.4 门禁与恢复

```text
POST /runs/:runId/gates/scope/decisions
POST /runs/:runId/gates/test-point-tree/decisions
POST /runs/:runId/actions/revise-scope
POST /runs/:runId/actions/retry-design-node
POST /runs/:runId/actions/resynthesize
POST /runs/:runId/actions/full-rerun
POST /runs/:runId/actions/re-audit
```

`retry-design-node` 的 body 只允许 `functional_design` 或 `non_functional_design`，且仅在对应节点失败时使用。

### 16.5 树

```text
GET   /runs/:runId/test-point-tree
PATCH /runs/:runId/test-point-tree
GET   /runs/:runId/test-point-tree/revisions
GET   /runs/:runId/test-point-tree/diff?from=&to=
POST  /runs/:runId/test-point-tree/approve
```

PATCH body 为 operations 数组和说明，不接受整棵树覆盖。

### 16.6 用例、数据和审核

```text
GET   /runs/:runId/test-cases?cursor=&dimension=&testMethod=&status=
POST  /runs/:runId/test-cases
GET   /runs/:runId/test-cases/:caseId
PATCH /runs/:runId/test-cases/:caseId
DELETE /runs/:runId/test-cases/:caseId
GET   /runs/:runId/test-cases/:caseId/revisions
GET   /runs/:runId/test-cases/:caseId/diff?from=&to=
POST  /runs/:runId/test-cases/:caseId/review-actions
POST  /runs/:runId/test-cases/batch-review-actions
GET   /runs/:runId/test-data-requirements
PATCH /runs/:runId/test-data-requirements
```

DELETE 是当前设计中的追加式 tombstone，不物理删除历史 revision。

### 16.7 覆盖、来源与历史

```text
GET /runs/:runId/coverage-audits
GET /runs/:runId/coverage-matrix?direction=basis_to_case|case_to_basis
GET /runs/:runId/basis-items/:basisItemId/source
GET /runs/:runId/retrieval-hits/:hitId/source
GET /runs/:runId/historical-cases/:snapshotItemId
GET /runs/:runId/historical-cases/:snapshotItemId/diff/:caseId
GET /runs/:runId/findings
POST /runs/:runId/findings/:findingId/actions
GET /runs/:runId/confirmation-items
POST /runs/:runId/confirmation-items/:confirmationItemId/actions
```

所有 source API 只读取 Snapshot 中固定内容。

Finding/Confirmation Action 使用 `expectedVersion` 追加保存。确认动作只能提交结构化决定、依据说明和适用范围，服务端将其标记为 `user_decision`，不能伪装成原始需求、方案或知识原文。每个确认项保存 `impactStage=analysis|tree|case|data|publication`；处置后由服务端返回必须执行的“修订范围”“修订并重新批准树”“重新具象化”或“重新审计”，不会自动改写既有 Artifact。

### 16.8 发布与导出

```text
POST /runs/:runId/test-case-set-versions
GET  /test-case-set-versions/:versionId
GET  /test-case-set-versions/:versionId/export.json
GET  /test-case-set-versions/:versionId/report.md
GET  /test-case-set-versions/:versionId/export.xlsx
POST /test-case-set-versions/:versionId/knowledge-asset-publication/retry
```

重复发布同一 contentSha256 返回同一逻辑版本；内容变化创建递增版本。知识资产入库失败返回已发布版本和独立 projection failure，不回滚用例集。

---

## 17. 前端工作台

### 17.1 路由

```text
?page=test-design
&projectVersionId=...
&testDesignId=...
&workflowRunId=...
&tab=workflow|analysis|retrieval|tree|cases|data|coverage|history
```

恢复时按三 ID 归属加载。缺少或非法 Run 显示错误/选择页，不自动跳到该设计最新 Run。切换项目版本清空 testDesign/run 查询参数。

### 17.2 创建页

- 使用分段控制选择“评审基线”或“知识库资料”；
- 切换分支清空另一分支未提交字段；
- 知识资产显示类型、逻辑路径、固定版本、状态和 Hash；
- 知识增强明确选择 disabled/selected_assets/fixed_index；
- 历史用例默认不选；
- 运行前检查显示四 Agent、输入完整性、Finding/冲突和阻断原因；
- 只有 open 项目版本和所有前置条件满足时允许开始。

### 17.3 工作台布局

- 顶部：三 ID、basisMode、五阶段、四 Agent、门禁、过期状态、取消/恢复/导出/发布；
- 左侧：模式化依据、历史来源、用户目标和推导项；
- 中间：工作流、分析、召回、树、用例、数据、覆盖、历史标签；
- 右侧：固定原文、节点编辑、用例表单、数据详情、Finding/待确认处置或覆盖缺口；
- 小屏改为可切换抽屉，不让三列挤压重叠。

### 17.4 工作流视图

必须区分：

- 四个 Agent 节点；
- 两个人工门禁；
- 树归并和覆盖审计服务节点；
- 节点依赖、attempt、模型、降级、时间和脱敏错误；
- 页面基于服务端状态轮询或事件更新，不使用前端计时器模拟进度；
- 不展示模型隐藏思维。

### 17.5 树编辑器

- 支持展开/折叠、同级/子级新增、移动、拆分、合并、删除、不适用和优先级；
- 使用稳定容器高度、虚拟/按分支加载和服务端分页摘要，支持 2,000 节点；
- 拖拽有按钮/键盘等价操作，焦点和层级使用 ARIA tree 语义；
- 保存显示 saving/saved/failed，不虚报成功；
- 412 冲突展示服务器 revision、当前本地修改和重新应用入口；
- 已批准树编辑前明确说明下游失效影响。

### 17.6 用例编辑器

- 结构化字段表单，不以 Markdown 大文本替代；
- UI/API 使用分段控制，切换时提示将移除不适用分支字段；
- 步骤、逐步期望、检查点、参数、依赖和清理支持增删排序；
- caseId、来源 ID、Hash 为只读；
- 当前 revision、review status、readiness、origin、reuseMode 始终可见；
- 本地未提交内容只保存在当前路由上下文，切 Run 前提示；
- 保存冲突禁止覆盖，支持字段级比较。

### 17.7 覆盖与发布

- 覆盖矩阵支持 basis -> point -> case 和反向展开；
- 明确区分未覆盖、部分覆盖、不可测、待确认、孤立、重复和 stale；
- 发布按钮显示服务端 blockers 列表；
- 前端不自行判断可发布，只展示 `publishReadiness` DTO；
- JSON/Markdown/Excel 均从指定 TestCaseSetVersion 下载，不从当前页面状态导出。

---

## 18. 权限与安全

### 18.1 权限

在 `ProjectVersionPermission` 增加：

```text
test-design:create
test-design:read
test-design:cancel
test-design:edit
test-design:review
test-design:publish
test-design:export
```

个人 Demo 可通过 Static grant 赋予同一可信 Principal 多项权限，但服务端仍逐接口检查。生产继续要求注入真实认证适配器，不能使用 bootstrap 身份。

### 18.2 输入信任边界

以下均为不可信输入：文档、知识召回、历史用例、模型输出、Skill/MCP 内容、客户端 ID、树 operation、用例字段、Worker 旧 attempt 返回。

服务端必须防护：

- Prompt injection 不能改变 DAG、Toolset、权限或门禁；
- Snapshot allowlist 之外的检索/补读硬拒绝；
- 跨项目/项目版本 ID 在 Store 查询和 Application 双重校验；
- locator 失败不做近似 latest 回退；
- 路径、文件名和 Excel 单元格做注入防护；以 `= + - @` 开头的非公式文本按安全文本写入；
- Markdown 渲染不执行原始 HTML/脚本；
- 文件响应设置安全 Content-Type、Content-Disposition 和长度上限。

### 18.3 Tool 与网络

第四期发布配置校验禁止：

- `skill_execute_script` 及任何派生脚本能力；
- 任意网络 gateway；
- Shell、filesystem、browser、HTTP write；
- Git、测试执行、压测和安全扫描工具；
- 风险为 write 的 Tool/MCP。

固定检索是 SmartHub 内部能力，不通过任意 HTTP Tool 暴露；远程 Embedding 只使用运行快照中的模型路由和部署凭据。

### 18.4 脱敏与事件

持久化公开执行事件只包含：用户可见文本、阶段、工具名称、参数摘要、结果大小、状态、ID、Token、时间和脱敏错误。禁止保存隐藏思维、Authorization、Cookie、API Key、签名、测试凭据、环境秘密和完整敏感正文副本到普通日志。

---

## 19. 一致性、幂等与恢复

### 19.1 核心不变量

1. Design、Run、当前树/用例/审计均属于同一 projectVersion；
2. `basisMode` 与主依据字段严格匹配且 Design 生命周期内不变；
3. 下游只读取已校验 Artifact，且全部上游 Hash 匹配；
4. Synthesis 只能读取明确批准的 TreeVersion；
5. 当前树 revision 变化使树批准和下游投影失效；
6. 当前用例/数据变化使旧审计 stale；
7. 审核决定只对目标 revision 有效；
8. 发布集合 Hash 必须等于有效审计集合 Hash；
9. 模型 ID、覆盖和发布声明均不可信；
10. 迟到结果不能进入 Artifact 或正式结果；
11. 历史来源永不被当前编辑覆盖；
12. 查询和导出从不默认 latest。

### 19.2 幂等层级

| 操作 | 幂等 Key |
|---|---|
| 创建 Run | projectVersion + testDesign + Idempotency-Key + logical input hash |
| Node 入队 | run + nodeKey + generation + attempt |
| Artifact 发布 | nodeRun + artifactType + contentSha |
| 树 operation | tree + baseRevision + clientOperationId |
| 用例保存 | case + expectedRevision + clientOperationId |
| 批量审核 | run + target revision set hash + clientOperationId |
| 用例集发布 | design + canonical contentSha |
| 知识资产投影 | testCaseSetVersion + contentSha |

相同 Key、不同 payload hash 返回 `IDEMPOTENCY_CONFLICT`，不能静默复用。

### 19.3 租约与 fencing

- Worker claim 使用 `FOR UPDATE SKIP LOCKED`；
- claim 时生成新 run token 并递增 fencing token；
- heartbeat 只延长匹配 token 的 running Job；
- Artifact/节点终态写入同时匹配 token、fence、未取消和未完成；
- lease 过期后新 Worker 可重领；旧 Worker 的写入影响 0 行并记录迟到事件；
- 语义/Schema 错误不自动基础设施重试，模型限流/超时按发布策略有限重试。

### 19.4 崩溃恢复

Worker 启动时：

1. 扫描租约过期 Job 并按 max attempts 重新排队或失败收敛；
2. 扫描 running/waiting Workflow 与持久化节点重新计算可执行节点；
3. 对 Artifact 已发布但 Node 未收敛的状态做幂等修复；
4. 不重新执行已成功且 Hash 合法的节点；
5. 不自动批准门禁；
6. 对取消请求补发取消传播。

---

## 20. 错误码

### 20.1 输入和快照

| Code | 含义 |
|---|---|
| `TEST_DESIGN_BASIS_MODE_INVALID` | basisMode 或分支字段非法。 |
| `TEST_DESIGN_REVIEW_CHAIN_INVALID` | Phase 3 未引用所选 Phase 2 Run。 |
| `TEST_DESIGN_ASSET_NOT_READY` | 固定资产不存在、不可读或非 ready。 |
| `TEST_DESIGN_LATEST_REFERENCE_FORBIDDEN` | 请求含 latest/active 动态引用。 |
| `TEST_DESIGN_INPUT_DELIVERY_INCOMPLETE` | 固定正文未完整投递。 |
| `TEST_DESIGN_HISTORICAL_SOURCE_INVALID` | 历史来源跨项目、未发布或定位失效。 |
| `TEST_DESIGN_AUGMENTATION_INVALID` | 知识增强判别联合非法。 |
| `TEST_DESIGN_AGENT_NOT_READY` | 四 Agent 任一未发布或模型门禁失败。 |

### 20.2 工作流和门禁

| Code | 含义 |
|---|---|
| `WORKFLOW_NODE_DEPENDENCY_NOT_READY` | 依赖未满足。 |
| `WORKFLOW_ARTIFACT_HASH_MISMATCH` | 交接 Hash 不匹配。 |
| `WORKFLOW_GATE_VERSION_CONFLICT` | 门禁目标已变化。 |
| `WORKFLOW_NODE_NOT_RETRYABLE` | 节点状态不允许指定恢复动作。 |
| `WORKFLOW_LEASE_LOST` | Worker 已失租约。 |
| `WORKFLOW_CANCELLED` | Run 已取消。 |

### 20.3 树、用例和发布

| Code | 含义 |
|---|---|
| `TEST_POINT_TREE_REVISION_CONFLICT` | If-Match 已过期。 |
| `TEST_POINT_TREE_CYCLE` | 操作产生父子循环。 |
| `TEST_POINT_TREE_APPROVAL_REQUIRED` | 无有效批准版本。 |
| `TEST_CASE_REVISION_CONFLICT` | 用例已被其他会话修改。 |
| `TEST_CASE_METHOD_SCHEMA_INVALID` | UI/API 判别字段非法。 |
| `TEST_CASE_BASIS_REFERENCE_INVALID` | 来源不属于固定快照或模式不匹配。 |
| `TEST_CASE_DEPENDENCY_CYCLE` | 用例依赖形成循环。 |
| `COVERAGE_AUDIT_STALE` | 当前集合与审计 Hash 不一致。 |
| `TEST_CASE_REVIEW_REQUIRED` | 当前 revision 未批准。 |
| `TEST_CASE_NOT_READY` | 当前用例/数据非 ready。 |
| `TEST_CASE_SET_PUBLICATION_BLOCKED` | 存在发布 blocker。 |
| `TEST_CASE_SET_HASH_MISMATCH` | 批准集合与审计集合 Hash 不一致。 |

HTTP 映射：输入 400、未认证 401、无权限 403、不存在/归属隐藏 404、状态冲突 409、ETag 412、Schema 422、限流 429、内部/依赖 500/502/503。错误正文只包含脱敏信息。

---

## 21. 可观测性

### 21.1 Trace

统一关联：

```text
requestId
 -> workflowRunId
 -> nodeRunId
 -> taskAttemptId
 -> agentExecutionId
 -> modelCallId / toolCallId
```

树/用例编辑增加 `treeRevisionId`、`caseId + revision`；发布增加 `testCaseSetVersionId`。

### 21.2 事件

至少记录：

- Run 创建、快照完成、入队、取消和终态；
- Node 解锁、claim、heartbeat 异常、重试、完成和迟到丢弃；
- 范围/树门禁决定；
- 召回计划、查询数量、命中数量、空结果和越界拒绝；
- 树 revision/批准/失效；
- 用例 revision、审核、复用方式变化；
- 审计创建/过期/blocker；
- 用例集发布和知识资产投影重试；
- 安全拒绝和敏感字段清理。

### 21.3 指标

```text
smarthub_workflow_queue_depth{workflow,node}
smarthub_workflow_node_duration_seconds{node,status}
smarthub_workflow_node_retry_total{node,reason}
smarthub_workflow_waiting_approval_total{gate}
smarthub_test_design_snapshot_items{kind}
smarthub_test_design_retrieval_hits{classification}
smarthub_test_point_count{dimension,status}
smarthub_test_case_count{method,dimension,review,readiness}
smarthub_test_case_reuse_total{mode}
smarthub_coverage_gap_total{kind,severity}
smarthub_coverage_audit_stale_total{reason}
smarthub_test_case_set_publish_total{status}
```

Token、模型耗时、队列耗时和工作流总耗时分别记录。

### 21.4 健康检查

`/api/health` 分项返回 API、PostgreSQL、Worker 最近心跳、模型可用性、Workflow 积压和租约过期数量。API 进程存活不能代表第四期可用。

---

## 22. 性能与容量

### 22.1 个人 Demo 验收基线

| 指标 | 目标 |
|---|---|
| 创建 Run 同步 API | 常规输入 p95 <= 2 s；容量上限输入 p95 <= 5 s，不等待模型 |
| 列表/筛选 API | p95 <= 500 ms |
| 树单次 operation 保存 | p95 <= 800 ms |
| 用例单次 revision 保存 | p95 <= 800 ms |
| 覆盖矩阵首屏 | p95 <= 1.5 s |
| 取消传播到运行模型/工具 | p95 <= 5 s，最大 10 s |
| Worker 崩溃后重领 | 一个 lease 周期内，默认 60 s |
| 页面主要交互 | 2,000 树节点/1,000 用例下无超过 2 s 的主线程冻结 |

基准环境需在实施验收记录中固定 CPU、内存、Node.js、PostgreSQL、pgvector、浏览器、数据集和模型 Provider；不能用“最新”表示版本。

### 22.2 容量

至少支持：

- 200 需求点；
- 100 方案要点或 500 KnowledgeBasisItem；
- 2,000 测试点节点；
- 1,000 当前候选用例；
- 2,000 历史用例；
- 1,000 数据需求；
- 四个 Agent 节点和多个 service/gate 节点。

### 22.3 保护策略

- 所有列表和矩阵服务端分页；
- 树按展开分支加载，父子/计数使用窄查询；
- Snapshot 正文按内容 Hash 去重；
- 模型输入、查询数、Top-K、单 Chunk、命中总字节、Artifact 和导出大小均有限制；
- 覆盖审计异步运行，不能阻塞 HTTP；
- Excel 使用流式写入；
- 工作流总 Token/成本和单节点预算分别限制。

建议初始默认：查询意图最多 20 个、单查询 Top-K 8、去重后总命中最多 80、单 hit 投递最多 2,000 字符、单 Agent Artifact 最大 8 MB。最终值需用验收集压测后固定。

---

## 23. 测试方案

### 23.1 单元测试

- 严格 `oneOf` 与未知字段拒绝；
- canonical JSON 与所有 Hash；
- DAG 拓扑、依赖、并行和 generation；
- Workflow/Node/审核状态机；
- KnowledgeBasis 唯一/歧义/越界定位；
- Tree operations、循环、Diff 和 ETag；
- UI/API TestCase 联合；
- 历史 semantic hash、unchanged/modified 转换；
- 用例依赖循环；
- Coverage 分母、状态、重复和失效；
- 发布 readiness 和 Excel formula injection 防护。

### 23.2 Store 与迁移测试

- 全新数据库迁移 1～18；
- 已有迁移 14 数据库升级；
- FK、CHECK、唯一键和索引存在；
- claim/heartbeat/release/fence；
- 并行节点只创建一次；
- Node 完成与 Artifact 发布原子性；
- Revision 并发写只有一个成功；
- 发布事务失败不产生半个版本；
- 删除/保留与 frozen content 引用计数。

### 23.3 Agent 合约测试

四个 Agent 分别覆盖：

- 正常 submission；
- 未知字段、越界 Ref、伪造 ID；
- 缺失分区、缺失 UI/API 专属字段；
- 非功能编造阈值；
- 树外用例；
- 数据先于用例候选提交；
- 提交次数耗尽；
- 迟到结果；
- 独立 session 和节点最小 Toolset；
- 禁止脚本、网络和写工具。

### 23.4 Workflow 集成测试

- review_baseline 完整路径；
- knowledge_assets 完整正文路径；
- disabled/selected_assets/fixed_index 三种增强；
- 功能/非功能并行；
- 范围/树门禁阻塞与批准；
- 一个设计节点失败后单节点重试；
- 树修订后重新具象化；
- 覆盖 blocker 处理与重新审计；
- 全部重跑产生新 Run；
- 取消、失租约、崩溃恢复和 Worker 重启；
- fixed input 更新后历史不漂移。

### 23.5 API 与安全测试

- 三 ID 归属、跨版本/跨项目访问；
- 每项新增权限；
- Idempotency-Key payload 冲突；
- If-Match 412；
- Prompt injection 和检索 allowlist 越界；
- SSRF/路径穿越/公式注入；
- 日志、事件、报告和错误脱敏；
- latest/active 引用硬拒绝；
- production bootstrap 认证拒绝。

### 23.6 前端测试

- 固定路由刷新；
- 创建页分支字段清理；
- 五阶段与四 Agent 展示；
- 树键盘操作、焦点和冲突；
- 用例结构化编辑、保存失败和 revision 冲突；
- 批量审核影响范围；
- Coverage stale 与发布 blockers；
- 1,000 用例/2,000 节点响应；
- Edge/Chrome 固定版本、中文路径、UTF-8、Asia/Shanghai 展示；
- 360 px、768 px、1440 px 布局无重叠。

### 23.7 Golden Set

固定验收集至少包含：

- 五类测试维度和八类设计方法；
- UI、API、异步副作用和数据检查点；
- 明确/缺失 SLA、恢复目标和兼容矩阵；
- 历史 reusable、modified、obsolete、conflict、needs_confirmation；
- 纯知识库输入、冲突资料、来源歧义、过期信息；
- 已知遗漏、重复候选、无 oracle、无数据、孤立节点；
- 树新增/移动/拆分/合并/删除；
- 中文路径、时区、编码和提示词注入。

Golden Set 固定输入 Hash 和期望服务端不变量，不要求模型逐字输出完全相同自然语言。

### 23.8 AC 自动化映射

| AC | 主要自动化层 |
|---|---|
| AC-401 | DTO/Service/Store 集成 |
| AC-402 | Workflow 集成 + UI |
| AC-403 | Agent 合约 + Retrieval |
| AC-404 | Tree Service + UI |
| AC-405 | Synthesis Schema + UI |
| AC-406 | Historical Snapshot/Reuse |
| AC-407 | NonFunctional Validator |
| AC-408 | Data Requirement Schema |
| AC-409 | Tool/安全测试 |
| AC-410 | Coverage Auditor |
| AC-411 | Workflow 恢复/取消 |
| AC-412 | Edit/Review/Export/Publish |
| AC-413 | TestCaseSet consumer contract |
| AC-414 | 路由/固定内容/兼容 |
| AC-415 | 能力与 Toolset 负向检查 |

---

## 24. 需求追踪矩阵

### 24.1 功能需求

| 需求 | 技术落点 | 核心测试 |
|---|---|---|
| FR-601 | 10、15、16 | 严格联合、固定输入、跨域拒绝 |
| FR-602 | 7、15 | 运行快照、状态、原子候选 |
| FR-603 | 7、9 | DAG、Artifact、并行与门禁 |
| FR-604 | 10、11 | 依据解构、KBP、固定召回 |
| FR-605 | 11、12 | 两专项协议、树归并 |
| FR-606 | 11、13 | 用例/数据两次提交 |
| FR-607 | 14 | 审计顺序、覆盖、失效 |
| FR-608 | 16、17 | 三 ID 路由、固定来源 |
| FR-609 | 10、13 | 历史快照、复用和 Diff |
| FR-610 | 12、13、16 | ETag、revision、审核 |
| FR-611 | 13～16 | Schema、Hash、不可变发布 |
| FR-612 | 8、16 | JSON/MD/XLSX 与资产投影 |
| FR-613 | 9、18 | 独立配置、只读 Toolset |

### 24.2 非功能需求

| 需求 | 技术落点 |
|---|---|
| NFR-401 | 16、22 |
| NFR-402 | 7、15、19 |
| NFR-403 | 17、23 |
| NFR-404 | 18、23 |
| NFR-405 | 14、21、23 |

### 24.3 追踪完成门禁

每个 FR/AC 的测试必须在测试名或元数据中携带编号；仅在文档表中声明“覆盖”不算完成。实施 PR 需生成一份测试到 FR/AC 的机器可读清单，并检查没有缺失、重复占位或只依赖手工描述的 P0 场景。

---

## 25. 实施里程碑

### M0：协议与验收集锁定

- 确认 11.2 的产品待确认项；
- 固定 `test-analysis/v1`、两个 design/v1、synthesis/v1、tree/data/case/set v1；
- 固定 Golden Set、Hash 规则、错误码和容量环境；
- 输出 Schema fixtures 和 consumer validator。

完成门禁：协议测试可独立运行，需求追踪无空项。

### M1：Workflow 与 Snapshot 基础

- 迁移 15/16；
- Definition Registry、Scheduler、Job、Artifact、Gate；
- 两种依据快照、历史快照、frozen content；
- 公平 Worker Handler Registry；
- 创建/历史/取消 API。

完成门禁：无模型 fixture 能完成 DAG 状态、并行、门禁、取消和恢复测试。

### M2：四 Agent 与固定召回

- 扩展 Agent 配置和定义；
- Context Assembler、Fixed Retrieval、KBP Resolver；
- 四类 submission Tool 和 Validator；
- 公开执行事件和限制。

完成门禁：两种模式使用 fixture Agent 产生合法固定 Artifact，越权 Tool 全部拒绝。

### M3：树、用例、数据与审计

- 迁移 17/18；
- Tree Merger/Revision/Version；
- Case/Data candidate、历史复用、revision、审核；
- Coverage Auditor 和失效传播；
- TestCaseSet 发布、三种导出和知识资产投影。

完成门禁：后端 API 闭环和 `test-case-set/v1` consumer 测试通过。

### M4：前端闭环

- 创建页、三栏工作台和固定路由；
- Workflow、树、用例、数据、Coverage、历史 Diff；
- ETag 冲突、审核、导出和发布；
- 响应式、键盘和容量优化。

完成门禁：固定浏览器 E2E、可访问性和大数据集交互通过。

### M5：真实模型、验收和文档

- 固定 Agent 配置和模型 Probe；
- Golden Set 真实模型验收；
- 性能、安全、崩溃恢复和迁移演练；
- README、需求和技术文档对齐；
- 记录最终命令、环境和结果。

完成门禁：AC-401～AC-415 全部有可复核证据。

---

## 26. 配置、发布与回滚

### 26.1 建议配置

```text
SMARTHUB_TEST_DESIGN_ENABLED=false
SMARTHUB_TEST_DESIGN_NODE_CONCURRENCY=2
SMARTHUB_TEST_DESIGN_MAX_ACTIVE_RUNS=2
SMARTHUB_TEST_DESIGN_MAX_TREE_NODES=2000
SMARTHUB_TEST_DESIGN_MAX_CASES=1000
SMARTHUB_TEST_DESIGN_MAX_HISTORICAL_CASES=2000
SMARTHUB_TEST_DESIGN_MAX_DATA_REQUIREMENTS=1000
SMARTHUB_TEST_DESIGN_MAX_QUERY_INTENTS=20
SMARTHUB_TEST_DESIGN_RETRIEVAL_TOP_K=8
SMARTHUB_TEST_DESIGN_MAX_RETRIEVAL_HITS=80
SMARTHUB_TEST_DESIGN_MAX_ARTIFACT_BYTES=8388608
SMARTHUB_TEST_DESIGN_CANCEL_POLL_MS=2000
```

这些是部署保护，不替代 Agent 发布版本中的节点 limits。环境值必须由集中配置解析并校验正整数/合理范围。

### 26.2 发布顺序

1. 备份并执行迁移 15～18；
2. 发布兼容新表但 feature flag 关闭的 API/Worker；
3. 验证健康检查、公平领取和旧 Phase 1～3 回归；
4. 发布四个 Agent 配置并通过模型门禁；
5. 发布前端，但保持入口隐藏；
6. 对验收项目版本开启 feature flag；
7. 完成 Golden Set 和容量观察后逐步开放。

### 26.3 回滚

- 关闭 feature flag，停止创建新 Run；
- 允许已创建 Run 只读查看，必要时取消活动节点；
- 回滚应用代码时保留迁移表，不删除第四期数据；
- 不回滚或改写已发布 TestCaseSetVersion；
- 知识资产投影失败可独立重试，不影响用例集；
- 数据库结构物理回退只在备份恢复演练中进行，不通过应用启动脚本 DROP 表。

---

## 27. 风险与待确认事项

### 27.1 主要风险

| 风险 | 影响 | 控制 |
|---|---|---|
| 输入和树过大 | Token/耗时失控 | 完整投递证明、确定性分段、容量上限 |
| 通用 DAG 过度设计 | 延迟交付 | 只实现固定定义登记与本期所需节点类型 |
| 固定召回仍读取 active | 历史漂移 | 独立 Fixed Retrieval API 和负向测试 |
| 两分支重复/冲突 | 用例膨胀或丢失 | 保留原产物、关系建组、人工树门禁 |
| 非功能指标编造 | 错误验收标准 | 来源 Ref 强制校验和 blocker |
| 编辑后沿用旧审计 | 发布不一致 | 数据库失效传播和发布 Hash 硬门禁 |
| 历史 unchanged 误判 | 来源审计失真 | semantic hash + 字段 Diff |
| Worker 队列饥饿 | 第四期或旧任务不运行 | 公平领取、分类型队列指标 |
| Excel 公式注入/内存 | 安全与稳定性 | 安全文本、流式写入、大小上限 |
| 冻结正文存储增长 | 数据库膨胀 | 内容寻址去重、owner Ref、保留策略 |

### 27.2 实施前必须确认

1. Edge、Chrome、Node.js、PostgreSQL、pgvector 和模型 Provider 的固定版本矩阵；
2. selected_assets/fixed_index 的 Top-K、阈值、重排和最大语料；
3. 单 Run 输入、Token、树、用例、历史、数据和总时长上限；
4. 强制设计方法、默认树根模板和零/多用例理由枚举；
5. 两种覆盖的 blocker 策略和质量门槛；
6. 非功能指标词典、风险等级和组织模板；
7. 数据标签、敏感级别和后续造数交接协议；
8. 未处置上游 high/blocker 与知识冲突是否强阻断；
9. 范围、树、用例审核和发布责任人；
10. JSON/Markdown/Excel 模板、Sheet 和逻辑路径命名；
11. 历史默认候选范围和重复复用统计；
12. knowledge_assets 首批允许类型和资料优先级。

上述问题不影响基础架构开发，但 M0 结束前必须形成版本化决策；不能由 Agent 在运行中自行决定。

---

## 28. 报告与发布格式

### 28.1 规范 JSON

`TestCaseSetVersion.canonicalContent` 是唯一正式机器契约，至少固定：

- schema/set ID/version/projectVersion/basisMode；
- Basis/Retrieval/Tree/Data/Audit ID 与 Hash；
- 来源 Workflow；
- approved case revision set Hash；
- cases、data requirements、relations、review/reuse summary；
- contentSha256、publishedBy、publishedAt。

后续执行阶段只接收 `testCaseSetVersionId + caseId[]`，且只能选择该版本内 `approved + ready` 用例。

### 28.2 Markdown

章节固定为：报告信息、输入快照、五阶段、测试点树、用例、数据需求、模式化覆盖、Finding/确认项、历史沿革、审核与发布摘要。Markdown 不包含隐藏思维、自由对话或原始模型响应。

### 28.3 Excel

固定 Sheet：

1. `用例`；
2. `测试点`；
3. `测试数据`；
4. `覆盖审计`；
5. `来源与历史`；
6. `版本信息`。

复杂字段以稳定 JSON 片段或关联 Sheet 行表达，不用不可解析的自然语言拼接替代规范 JSON。三个格式携带同一 version、caseId 和 contentSha256。

---

## 29. 结论

第四期不应在现有某个评审 Service 中继续追加分支，也不应让一个万能 Agent 自由规划。正确实施方式是在现有受控 Agent 执行单元之上增加服务端固定 DAG 和独立第四期领域模型：两种主依据形成不可变快照，四个 Agent 通过结构化 Artifact 协作，测试点树与用例由人工追加修订，正式覆盖由服务端审计，最终只发布经过审核且 Hash 完全一致的不可变 `TestCaseSetVersion`。

该方案保留 Phase 1～3 的固定输入、Evidence、Agent 配置、Tool 治理和 Worker 可靠性原则，同时明确补齐当前仓库尚不存在的 DAG、树编辑、用例 revision、数据需求、覆盖审计和机器可读发布能力。脚本编写、真实造数和测试执行仍属于后续独立阶段。
