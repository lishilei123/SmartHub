# SmartHub 需求分析、测试设计与测试执行闭环

当前仓库已实现资料接入与检索、统一需求分析、需求发布、测试设计和测试执行闭环。需求分析与测试设计由同一个 `PlanningAgent` 在同一个 ProjectVersion Planning Session 和完整 Project Workspace 中连续完成；测试执行由确定性的 `TestExecutionService` 编排三个独立发布的 `TestScriptAgent`、`FailureAnalysisAgent`、`ScriptRepairAgent`，并只把服务端校验后的 `ExecutionPackage` 交给非 Agentic OCI Playwright Runner。PostgreSQL 保存正式状态，Workspace 与 Artifact Store 只保存不可变投影和产物。

测试设计运行启动时只冻结当前 ProjectVersion 明确绑定的 Requirement Release，并把 `releaseId`、`verificationRunId`、`RequirementRelease.content`、Release Content Hash 与完整 Workspace 文件清单写入不可变 Run Snapshot。人工发布后创建不可变正式用例库、套件与 `TestExecutionHandoff`。执行 Run 仅接受 Handoff 与服务端环境标识，冻结业务输入、环境签名、Runner 和三个 Agent 配置快照；每次真实 Runner 启动、新脚本 Revision、失败诊断与修复都保留独立历史，未满足 PostgreSQL、Artifact、Agent 或 OCI Runner readiness 时拒绝创建真实执行。

## 模块状态

| 模块 | 当前状态 | 边界 |
| --- | --- | --- |
| 知识库、需求分析、测试设计 | 已实现 | 已接入真实 API、持久化数据、Agent Workflow 和服务端治理。 |
| 测试执行 | 已实现 | 以不可变 `TestExecutionHandoff` 为唯一正式输入；Service 确定性编排、三个隔离 Agent、OCI-only Runner、不可变 Attempt/Revision/Diagnosis/Artifact 与真实状态前端。 |
| 报告与诊断 | 已实现 | 绑定单个 `ExecutionRun`，从 PostgreSQL 正式事实确定性投影指标、九类诊断、非通过明细与完整追溯，并提供 canonical JSON 和 Markdown 导出。 |

左侧“测试执行”展示 PostgreSQL 中的真实 Run/Task、就绪状态、冻结快照和不可变历史，不生成示例进度；“报告与诊断”只读汇总同一 Run 的正式事实，不调用 Agent 或 Runner，也不修改执行状态。

## 已实现

- 测试执行：固定 `PlanningAgent → TestExecutionService → ExecutionPackage → OCI Playwright Runner` 边界，三个执行 Agent 分别发布与冻结，Service 独占状态、重试、诊断和修复决策；支持 UI/API 与 smoke/regression/full/custom，不支持的方法明确落为 `unsupported` 且不创建脚本或 Runner Attempt；
- 报告与诊断：以 `REPEATABLE READ READ ONLY` 一次读取单个 Run 的 Task、Attempt、Diagnosis、ScriptRevision、Artifact 及冻结来源，Service 确定性计算执行概览、耗时分布、首轮质量、稳定性、自愈和九类诊断分布；非通过任务展示正式诊断、建议与脱敏 Artifact 元数据，追溯 Handoff、Library、Suite、环境、Runner 和三个 Agent 快照；
- 测试设计：统一 `PlanningAgent`、`test-case-design/v3` Candidate、扁平 `test-case/v3`、显式 Requirement 引用、服务端 Coverage Audit、受控 v3 Repair、直接语义审核、正式用例库发布与 UI/API 方法级执行交接；Service 独占 Case ID、Revision、Hash、历史匹配和正式版本治理；

- 平台固定服务一个 SmartHub 项目，启动时自动解析并复用该项目的默认知识库；前端不提供项目创建、项目选择或项目切换；
- 项目空间通过项目版本隔离：必须先创建或选择版本才能进入需求分析；版本可设为 `open`、`locked` 或 `archived`，后两种状态只读；新版本可选择只继承来源版本的需求绑定，不继承需求分析运行与对话；
- 页面启动时由后端解析并复用唯一的 SmartHub 默认知识库，不依赖浏览器 localStorage 决定数据归属，刷新、切换访问域名或开发模式重复挂载不会创建并切换到新空库；
- UTF-8 Markdown/TXT 支持单文件上传、一次多选批量上传，也可通过 ZIP 批量导入；ZIP 保留子目录结构，并支持 Markdown 以相对路径引用其中的 PNG、JPG、GIF、WebP 和 SVG 图片；
- 知识库目录创建、重命名、移动和递归删除持久化到 PostgreSQL；选中目录后上传会自动使用对应逻辑路径；
- 知识文件可从文件树或预览区执行重命名、跨目录移动和删除；操作同步更新 PostgreSQL、活动索引及默认文件目录，删除时保留不可变版本快照；
- 稳定资产、不可变资产版本、内容 Hash 去重与稳定 Chunk；Markdown 使用 AST 结构边界和模型实际 tokenizer 切分，目标/最大 Token 数、相邻重叠、代码块与表格完整性均进入切分流程；
- 未变化 Chunk 的 Embedding 复用和变化 Chunk 增量处理；
- 上传只固化不可变快照并创建持久化 `queued` 任务，由 Worker 异步完成解析、Embedding 和索引发布；
- 同步/重建任务、进度、失败重试、取消、中断恢复和旧活动索引连续可用；
- 候选索引在任务、配置、成员范围和向量维度校验后的条件事务切换；重建不改写不可变资产版本 Chunk；
- 配置版本、查询配置即时生效和兼容配置受控重建；
- SmartHub 本地模型来源始终存在且不可删除，其中的模型可以添加、运行、停止或全部删除；删除运行中模型会先释放实例。每个知识库可独立添加远程来源、Base URL、API Key 和模型；读取配置与保存响应不会回显 API Key。向量维度不需要手工填写，本地模型启动后从运行时读取，远程模型通过一次不指定维度的 Embedding 请求自动检测；远程调用失败时明确失败而不降级为 Hash 向量；
- 本地模型添加框提供经过 Transformers.js 模型页核对的推荐模型，可搜索并一键填入，同时保留任意 Hugging Face 模型名称的自由输入；
- 资产/版本浏览及关键词、向量、混合检索；PostgreSQL 使用 pgvector 和 HNSW 执行向量召回、pg_trgm 执行关键词召回，再按配置的两路召回数量融合并执行二阶段语义重排；向量服务故障时混合检索降级到关键词，纯向量返回明确不可用状态；
- Reranker 可独立选择模型来源和模型；重排阶段按所选来源使用对应的本地运行实例或当前知识库保存的远程路由，不要求与知识库 Embedding 模型相同；
- “系统管理 → 模型管理”已接入服务端 AI 资源目录：模型页维护 Base URL、API Key、模型、能力、启停与优先级，添加、编辑、启停和删除均即时保存；MCP、Skill、工具页同样可维护真实运行资源。随应用发布的内置 Tool 和 Skill 始终启用，管理页不允许关闭，服务端也会拒绝停用请求并自动修复历史停用状态；是否授权给具体 Agent 仍由 Agent 配置及必需能力约束决定。MCP Runtime 使用官方 TypeScript Client，通过 Streamable HTTP 或兼容 SSE 执行 `tools/list` 与 `tools/call`，并同时校验 Agent 发布快照、MCP 策略 Hash、服务白名单和 Tool 白名单；Bearer/OAuth Access Token 只按配置的环境变量名称从部署环境读取，不写入数据库。随应用发布的内置 Skill 位于 `server/skills`；项目外置 Skill/Tool 分别位于 `ai/skills`、`ai/tools`，服务启动和目录读取时扫描，并默认每 1 秒自动重扫。外置 Skill 通过同目录 `skill.json` 登记；外置 Tool 可使用无 JSON 的单文件静态清单、`*.tool.json`、目录 `tool.json`、批量 `tools.json` 或 `package.json` 的 SmartHub 声明。管理页标记为“外置”，只允许启停，编辑或删除应修改文件。运行开始时只把当前 Agent 发布版本绑定的 Skill Catalog 注入 Prompt；Agent 根据最新任务自主调用内部只读 `skill.read` 获取所需固定正文，同一执行轮重复读取由 Runtime 缓存并重放。若 Skill 的同目录 `skill-runtime.json` 声明了 PowerShell 脚本或网络 Origin，Runtime 仅为本次已绑定的 Skill 动态注册内部调用协议，不出现在 Tool 目录，也无需在 Agent 配置中重复选择。Skill 正文不能改变这些权限；脚本路径、网络 Origin/方法、重定向、超时、内容大小、发布配置 Hash 和调用次数仍由服务端强制校验。自定义 Tool 支持 `ai/tools`/`server/tools` 本地模块、HTTP JSON API 和 MCP；所有能力继续经过 Agent Tool 白名单、风险、调用次数与重复调用策略治理；
- “系统管理 → Agent 配置”分别维护 PlanningAgent 与测试执行 Agent 的模型路由、输出上限、超时、重试、Prompt、Tool/MCP/Skill 和运行限制，并拥有不可变发布版本。运行时固定 Toolset、MCP 策略与 Skill 内容 Hash；Workflow 只收窄当前 Stage 可调用的业务 Tool，不再过滤或激活 Skill。
- 声明 `tool_calling` 的生成式模型必须在健康探测中真实完成一次受控函数调用，普通文本响应不能冒充工具能力；各 Agent 通过自身结果提交工具提交协议结果，最终结果仍由应用服务复验；
- 检索支持逻辑路径筛选；结果绑定固定索引成员元数据、资产版本、标题路径、Chunk 和原文行号，页面按结果的 `assetVersionId` 打开只读证据版本；
- 需求分析上传支持 Markdown、TXT 和 ZIP，上传前可选择“需求文档”或“产品原型”；需求文档写入 `workspace/branches/{项目版本名}/input/requirements/`，产品原型写入同版本的 `input/ui/`。知识库页面以“知识库”为根节点，直接展示与 Pi Agent 相同的 `/workspace` 文件树，并补齐各项目版本、`shared` 和 `agent_workspace` 的标准空目录。ZIP 保留包内子目录和图片相对路径；启动分析时服务端固定需求输入范围，并把活动索引中整个 `/workspace` 的 ready 文档版本物化为本次运行的只读文件快照，让 Pi Agent 可自主查看当前分支、其他分支和 `shared` 资料；正式 ReviewRun、工作区快照、成功结果、失败/取消终态和安全执行事件持久化到 PostgreSQL/JSON；
- AC-001～AC-009 自动化验收场景。

## 当前已实现的统一 PlanningAgent 测试设计流程

- `PlanningAgent` 发布配置决定启用哪些 Skill；运行开始时只加载 Enabled Skill Catalog，Agent 自主判断何时通过 `skill.read` 读取正文。Workflow 只推进业务 Stage、收窄 Tool/提交协议和执行 Gate，不调度或激活 Skill。
- `test_case_design` 阶段由 Runtime 直接提供完整冻结的 `RequirementRelease.content`，并从 `currentInputRefs` 识别本次任务重点；Agent 可在 Project Workspace Snapshot 内按需读取用户资料和明确列出的历史快照，最终只提交根字段为 `schemaVersion`、`cases` 的 `test-case-design/v3` Candidate Delta。未变化历史用例无需重新输出；存在冻结历史基线时 `cases: []` 合法。
- 每条 AI 提交的 `test-case/v3` 只包含 `ref`、`schemaVersion`、`title`、`dimension`、`priority`、`requirementRefs`、`executionMethods`、`preconditions`、`steps`、`expectedResults`。Service 将 `ref` 作为本轮候选身份处理，正式 Library 内容只冻结其余九个测试语义字段。`requirementRefs` 必须存在但允许为空；空数组表示扩展风险测试，不计入正式 Requirement Coverage。非空引用必须属于当前冻结 Requirement Release。
- Historical Baseline 只由 ProjectVersion 的显式继承决定：`sourceProjectVersionId + inheritRequirementBindings=true` 时固定使用来源版本最新正式 TestCase Library；来源版本尚无正式 Library 时仍在不可变 Run Snapshot 中冻结 `sourceProjectVersionId`，但不伪造 Library 或 Requirement Release 字段，并按空 Historical Baseline 继续。未开启继承时不记录来源版本。创建协议和页面不再提供 `none/latest/library/suite` 第二套历史来源选择，也不会从其他版本、Suite、Workspace 投影或 Knowledge 搜索补充历史基线。
- Service/Validator 校验严格字段白名单、语义内容与 Requirement 引用；Service 冻结来源 ProjectVersion、Library Version、来源 Requirement Release、来源 Case Traceability，再把 Candidate Delta 按唯一 Test Intent 精确匹配 `reuse`、唯一高置信同意图变更 `update`、无可靠匹配 `create` 合并为 Effective Case Set。未命中的历史项一律保留，歧义匹配安全降级为 `create` 并给出 Advisory，绝不从 AI 省略推导 `deprecate`。正式废弃只通过用例库人工管理入口触发。
- `test_case_design` 和 `test_design_repair` 由同一个 `PlanningAgent` 执行。Agent 和 Skill 均不能切换 Stage、扩大 Tool 权限或发布正式版本；人工审核只针对 create/update 或人工修改，未变化的历史复用无需重新审核，发布仍由 Service 门禁控制。
- `semanticSha256` 只对标题、维度、优先级、执行方式、前置条件、步骤和预期结果这些 Test Intent 字段求 Hash，不包含 `requirementRefs`；`contentSha256` 仍覆盖完整 TestCase v3 内容。Requirement 编号变化本身不会创建新 Revision。
- Coverage Audit 是服务端确定性步骤，不是 Agent Stage。Service 使用规范化业务语义 Fingerprint 与唯一高置信规则，把来源 Release Requirement 保守映射到当前 Release；相同 `RP-xxx` 字符串从不作为跨版本证明。Coverage 只消费 Effective Case Set 的 `effectiveRequirementRefs`，并且只对 `coverageTarget=true` 的 Requirement 计算总数、覆盖数和未覆盖 Repair。歧义或无法映射只产生 Advisory，历史 Case 继续保留但不虚增 Coverage；`requirementRefs=[]` 的扩展测试仍进入最终资产。
- `test_design_repair` 只接受 `test-design-repair/v3` 的 `baseCandidateSha256`、`upsertCases` 与 `removeCaseRefs`，且只修改本轮 Candidate Delta。移除历史 update Candidate 会回退为冻结历史 Revision，不会删除或废弃正式 Historical Case。
- 发布后的正式用例库是 Historical Baseline + accepted Update + accepted Create 的完整合集，并保存完整 TestCase v3 语义。Library Member 另外冻结当前 ProjectVersion 的 Requirement Release Traceability：历史复用保持原 Case Revision 与其原始追溯不变，但成员使用映射后的当前 Requirement refs。项目级 Case 详情分别展示 Revision 原始追溯与各 Library Version Member 当前版本追溯。Execution Handoff 只消费该不可变完整 Library，并按 `executionMethods` 展开 UI/API 方法级成员。Selector、Endpoint、账号、环境和测试数据属于 Execution Run 的 Execution Context，不进入 TestDesign Candidate。
- 自动校验后的用例集投影到 `workspace/branches/{version}/test_cases/test-cases.json|test-cases.md|manifest.json`。每个文件都先进入正式 Asset/AssetVersion 体系，数据库与 Workspace 不形成双真相。

本地开发默认通过 `.env.local` 的 `DATABASE_URL` 使用 PostgreSQL；项目、知识库、资产版本、索引、同步任务、模型与 AI 资源、Agent 配置、ReviewRun/Job，以及 TestDesign Workflow、Snapshot、树、用例 revision、Coverage、用例集、套件和交接均写入 `smarthub` schema。旧技术方案表和旧测试设计数据由迁移直接删除。写事务在数据库锁内读取最新状态并只对变化实体执行 UPSERT/定向删除；未配置 `DATABASE_URL` 时回退到 JSON 文件，生产模式必须使用 PostgreSQL Worker。

生产 API 注入 SmartHub 内置模型运行池。知识库配置先选择来源，再选择该来源中的生效模型；本地模式下上传解析、索引重建和向量/混合检索均路由到所选模型，发现模型未运行时会自动拉取并启动，同时不会停止池内其他模型。单元测试通过运行时接口注入轻量测试模型，不下载大模型。

## 当前已实现的统一 PlanningAgent 需求分析流程

> 需求分析与测试设计只保留同一个 `PlanningAgent`，并且只接受 `/workspace` 文件工作区。Agent 基于 Pi Agent Core 运行，使用只读 `ls / find / grep / read` 与受控 Knowledge 工具自主探索固定资料，在同一个 ProjectVersion Planning Session 内完成需求分析；Requirement Release 发布后，Workflow 把“开始测试设计”作为下一项真实 Session 消息下发给同一个 Agent，后续上下文可直接读取该任务。旧 `RequirementPointExtractionAgent`、`RequirementReviewAgent` 及其独立提交工具、草稿和配置快照均已删除。

需求分析完成且阻断 Clarification 全部处置后，Service 在同一事务中校验固定输入、生成并绑定唯一的 Requirement Release；不再维护独立的 Requirement Understanding Stage/Snapshot，也不存在 Agent 生成 Release Candidate 后再人工发布的第二条路径。Planning Session 只提供语义连续性，下游正式事实始终来自已发布的 `RequirementRelease.content` 与固定 Content Hash。

统一逻辑目录如下：

```text
/workspace/
├── branches/{release}/
│   ├── input/{requirements,api,ui,environment}/
│   ├── test_design/
│   ├── test_cases/
│   ├── scripts/
│   ├── execution/
│   └── reports/
├── shared/{knowledge,common_scripts,common_docs}/
└── agent_workspace/{requirement_agent,design_agent,execution_agent,report_agent}/
```

- `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和 `@earendil-works/pi-coding-agent` 的实际版本由 `package-lock.json` 固定；业务层继续只依赖 `AgentRuntime`；
- 当前项目版本的需求输入目录固定为 `workspace/branches/{projectVersion.name}/input/requirements`，产品原型归档到同分支的 `input/ui`。新运行冻结需求目录中的正式 coverage 范围，同时冻结活动索引中整个 `workspace/` 的 ready 文档版本；因此 Agent 能把产品原型与 `input/api`、`input/environment`、`shared/knowledge` 一样作为旁证自主读取，但正式需求 coverage 仍只计算需求输入目录；
- 运行开始时，服务端将固定 `AssetVersion.content` 物化到 run-scoped 临时目录，预建完整工作区层级，并在结束、失败或取消后清理。Agent 只能传相对路径；绝对路径、盘符、UNC、`..` 和越界 Glob 均被拒绝；不开放 Shell、write、edit 或任意文件系统权限；
- 首轮 Prompt 只投递工作区根、活动分支、需求输入目录、文件数量和快照 Hash，不投递文件名、Chunk 清单或正文。Agent 使用 `ls` 看目录、`find` 找文件、`grep` 定位文本，再用 `read` 的 `offset / limit` 分段读取大文件；
- 只有 `read` 实际返回的固定文件行范围会写入 `InputDeliveryManifest.toolReads` 并形成 Evidence 候选。`grep` 和 `find` 只用于定位；资产版本、内部 Chunk、Evidence、需求点 ID、`evidenceRefs`、coverage 和 locator 全部由服务端生成和校验；
- 已发布 `PlanningAgent` 必须包含 Workspace 只读工具、Knowledge 查询工具和各阶段的服务端提交工具；运行开始时仅加载已绑定 Skill 的 `skillKey/name/description/version/tags` Catalog，不再把全部正文注入 System Prompt。PlanningAgent 根据最新任务自主调用 `skill.read`，Runtime 再校验 enabled binding、发布版本、configurationHash（含内容 Hash）并返回 `TRUSTED_SKILL` 正文；不使用 Stage → Skill 映射，Skill 仍不能切换 Stage 或扩大 Tool 白名单；
- Agent 定义、Prompt、Toolset、Skill、MCP、模型路由、执行限制和内容 Hash 独立版本化并写入运行快照。模型只提交语义候选，正式 RP、Evidence、Finding、coverage、Artifact 与发布门禁由服务端生成和校验；
- 需求分析 Run 持久化统一 Agent 的公开模型消息、工具参数/返回和语义事件时间线；需求分析右侧“Pi Agent”面板按秒刷新任务、Stage、读取文件路径、函数调用、公开结果和错误，不提供独立问答入口；
- 调用分析接口时先创建 `running` 需求分析 Run 和持久化 Job 后立即返回；独立 Worker 通过 lease、heartbeat、run token 和 fencing 执行，只有当前租约持有者可以冻结阶段结果或发布正式结果。Worker 失租约后任务可重新领取，超过次数或取消后进入明确终态，晚到结果不能覆盖。只有 `open` 项目版本允许物理删除；删除时级联移除该版本的需求绑定、已结束分析 Run、FindingAction、审批和运行记录。存在 `running` 分析 Run 时必须先取消，`locked/archived` 版本不可物理删除；
- 失败或取消后的重跑只支持 `full`，会沿用来源运行的需求目录并按当前活动索引重新固定候选文档；任何重跑都创建新的需求分析 Run，不覆盖原运行。

当前自动化测试已覆盖首轮上下文不泄露文件清单与正文、完整目录树、当前分支与 `shared/knowledge` 自主读取、路径穿越拒绝、实际 `read` 行范围形成 `toolReads`、未读范围不可用于 Evidence、需求覆盖、需求点规范化和 Finding 引用。

运行前需要先创建一个状态为 `open` 的项目版本，把至少一份需求文档上传到当前版本的 `input/requirements` 并等待 ready/活动索引，再到“系统管理 → 模型管理”让生成式模型通过 `model-probe/v2`，随后发布统一需求分析 Agent。启动 API 固定统一工作区快照并立即创建需求分析 Run/Job，Worker 在单个受治理 Session 中执行当前 Workflow Stage：

```powershell
$ErrorActionPreference = 'Stop'
$body = @{
  documentDirectoryPath = 'workspace/branches/V2/input/requirements'
  focusAreas = @('状态与异常', '可测试性')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/project-versions/<projectVersionId>/requirement-analysis-runs' -ContentType 'application/json; charset=utf-8' -Body $body
```

## 本地运行

运行环境要求 Node.js `>=22.19.0`，与当前锁定的 Pi 0.84.1 运行时一致。

安装依赖：

```powershell
$ErrorActionPreference = 'Stop'
npm install
```

同时启动 API 与 Web：

```powershell
$ErrorActionPreference = 'Stop'
npm run dev
```

启动脚本会在创建 API、Worker 和 Web 进程前检查 `127.0.0.1:8787` 与 `127.0.0.1:5173`。若完整的 SmartHub 开发实例已经运行，本次命令只显示已有实例与占用进程，不会再启动重复 Worker；若端口由其他或不完整的进程占用，命令会在启动前失败并给出 PID，不会自动终止可能正在处理任务的进程。Vite 使用严格的 `5173` 端口，不会静默回退到 `5174`。

浏览器打开 `http://127.0.0.1:5173`。首次使用先点击左侧版本入口新建项目版本，再进入“需求分析”；知识库和系统管理为全局页面，不随版本切换。API 默认监听 `http://127.0.0.1:8787`。网页先启动时会自动重试 API 连接，连接成功后“刷新”和“上传资料”自动恢复可用。上传 ZIP 时可指定目标目录；压缩包内的 Markdown/TXT 会异步进入索引，图片作为本地附件保存并用于安全预览，其他类型会跳过。

数据库连接写在不提交 Git 的 `.env.local` 中，可参考 `.env.example`。数据库需预先存在，并且 PostgreSQL 实例需要提供 pgvector；扩展与表结构由 API 自动创建：

```powershell
$ErrorActionPreference = 'Stop'
$env:PGPASSWORD = '<本机 postgres 密码>'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h 'localhost' -p '5432' -U 'postgres' -d 'postgres' -c 'CREATE DATABASE smarthub'
Remove-Item Env:PGPASSWORD
npm run migrate
```

进入“系统管理 → 知识库配置”后，系统内置的“本地模型”来源始终存在；本地模型可分别点击“运行/停止”，页面会展示每个实例的真实状态。点击“添加远程来源”可为当前知识库填写来源名称、Base URL、可选 API Key 及模型，支持 OpenAI Embeddings 兼容接口和 Ollama 原生接口；检测成功后保存配置，模型维度随配置版本持久化。读取配置和保存响应不回显 API Key，留空保存表示保留已保存的密钥。最后在“知识库生效模型”中依次选择来源和模型。SmartHub 内置模型由 API 进程直接运行，不需要安装 Ollama，也不需要填写本地地址。默认目录如下：

- 模型缓存：`data/models/cache`
- 当前上传文件：`data/knowledge-bases/{knowledgeBaseId}/files/{logicalPath}`
- 不可变版本快照：`data/knowledge-bases/{knowledgeBaseId}/versions/{assetVersionId}/source.md|txt`

可用 `SMARTHUB_MODEL_ROOT`、`SMARTHUB_DOCUMENT_ROOT` 和 `SMARTHUB_SKILL_ROOT` 覆盖系统级模型、文档与 Skill 包存储根目录。模型下载默认先访问 Hugging Face；仅遇到超时、SSL、连接重置等网络错误时，自动切换到 `https://hf-mirror.com/` 重试。可用 `SMARTHUB_MODEL_HUB` 指定主仓库，用 `SMARTHUB_MODEL_HUB_FALLBACK` 覆盖备用镜像；将后者设置为空字符串可关闭自动兜底。模型不存在或格式不兼容不会触发网络兜底。`SMARTHUB_DATA_FILE` 仅用于未配置 PostgreSQL 时的 JSON 回退。远程来源由知识库配置维护，不依赖 `SMARTHUB_REMOTE_EMBEDDING_SOURCES_JSON` 或 API Key 环境变量。

进入“系统管理 → 模型管理”后，直接填写来源的 Base URL、可选 API Key 和模型。服务端不会把 URL/API Key 转成环境变量；它们与当前向量模型配置一样，以明文配置值保存在数据库 JSON/JSONB 中。读取和保存响应返回 Base URL、`hasApiKey` 状态和空的 `apiKey`，编辑时 API Key 留空表示保留旧值，填写新值表示覆盖。

Skill 新建默认使用受控 ZIP 上传：压缩包最多 20 MB、200 个文件，单文件最多 5 MB、解压后总计最多 50 MB，并且必须且只能包含一个非空 UTF-8 `SKILL.md`。服务端校验 CRC，拒绝绝对路径、路径穿越、Windows 保留名、大小写冲突、符号链接与原生可执行文件，再原子解压到 `data/skills/{skillKey}/{version}`，记录压缩包 Hash、内容 Hash 和文件清单。已上传包的标识、版本、入口和包元数据不可原位覆盖；删除未被 Agent 引用的 Skill 时同步删除对应包目录。`ai/skills/{name}/skill.json` 至少声明 `key`、`name` 和 `version`，可声明 `description`、`entrypoint`（默认 `SKILL.md`）、`toolIds` 和 `tags`；同目录可选 `skill-runtime.json`，其中只可声明相对 `.ps1` 脚本、PowerShell 运行器、超时、精确 HTTP/HTTPS Origin 和 GET/HEAD 方法。目录内容与运行权限共同参与 Skill 配置 Hash。上传或扫描本身不会执行包内脚本；只有发布绑定该 Skill 的 Agent 才能按其固定清单调用。

保存来源后，点击模型名称会发起最小生成请求并持久化真实健康状态；“获取当前配置模型”对 OpenAI/OpenAI-compatible 来源请求服务端 `/models`。Anthropic 没有统一的标准模型列表接口，因此需手动注册模型，但可执行真实 `/v1/messages` 连通性探测。

进入“系统管理 → Agent 配置”后维护 `PlanningAgent` 与测试执行 Agent。页面维护模型路由、Prompt、Tool/MCP/Skill 和运行限制；必需能力不可取消，发布时固定 Toolset、Skill 内容与运行权限 Hash 以及 MCP Policy Hash。运行时只加载已绑定 Skill Catalog，正文由 Agent 通过 `skill.read` 按需读取；Workflow Stage 只收窄业务 Tool、提交协议和 Gate，不筛选或指定 Skill。

## 生产构建与运行

`npm run build` 同时生成前端 `dist/` 和可直接由 Node.js 运行的服务端 `dist-server/`。生产 API 会从 `dist/` 提供前端与 SPA 回退，因此不再依赖 Vite 开发服务器；API 和 Worker 使用相同代码产物启动：

```powershell
$ErrorActionPreference = 'Stop'
npm ci --omit=dev
npm run start:api:dist
npm run start:worker:dist
```

生产模式必须配置 `DATABASE_URL`。应用程序目录可通过 `SMARTHUB_APP_ROOT` 指定；所有可写运行数据默认位于其 `data/`，正式部署应通过 `SMARTHUB_DATA_ROOT` 指向应用包外的持久化目录，也可继续分别覆盖 `SMARTHUB_MODEL_ROOT`、`SMARTHUB_DOCUMENT_ROOT`、`SMARTHUB_SKILL_ROOT` 和 `SMARTHUB_DATA_FILE`。升级或替换应用包时必须保留数据库与该外部数据目录。

MCP/HTTP 凭据使用资源页面展示的环境变量名称注入，例如：

```powershell
$ErrorActionPreference = 'Stop'
$env:SMARTHUB_MCP_ISSUES_MCP_TOKEN = '<access-token>'
$env:SMARTHUB_HTTP_TOOL_ISSUES_LOOKUP_TOKEN = '<bearer-token>'
npm run start:api:dist
```

`server/tools` 是随应用发布、由内置配置登记的受控实现目录；`ai/tools` 是项目外置扩展目录。推荐的最简方式是单文件自描述：任意 `.ts`、`.js` 或 `.mjs` 模块静态导出名为 `tool`、`toolManifest` 或 `metadata` 的对象，声明 `key`、`name`、`version`、`risk` 和 `timeoutMs`，同时导出运行时需要的 `parameters` 与 `execute(arguments, context, signal)`。扫描器使用 AST 读取静态 JSON 兼容字面量，不会 `import` 或执行模块；示例见 `ai/tools/example-echo.ts`。

需要分离配置时还支持四种 JSON 入口：`*.tool.json` 描述一个模块；目录 `tool.json` 可省略 `module` 并按唯一的同名、`tool.*` 或 `index.*` 模块推断；`tools.json` 使用数组或 `{ "tools": [...] }` 批量登记；`package.json` 使用 `smarthub.tool` 或 `smarthub.tools`，并可复用包级 `module`/`main`。JSON 中显式 `module` 时始终以描述文件所在目录解析；同一模块既有 JSON 又有单文件清单时以 JSON 为准。服务端以描述文件和模块内容的 SHA-256 作为重载与发布绑定依据。TypeScript 会在构建时输出到 `dist-server`；安装后扩展可部署为 `ai/tools` 下的 JavaScript 模块。文件变化会自动刷新资源目录和模块缓存键；已发布 Agent 检测到内容漂移时拒绝静默加载，管理员需重新发布 Agent 配置后才会使用新版扩展。

## 验证

```powershell
$ErrorActionPreference = 'Stop'
npm test
npm run build
```

测试覆盖项目版本需求绑定隔离、显式继承和只读状态门禁，以及真实 Token 计数、上传/Worker 队列、索引切换、远程 Embedding、模型质量门禁、统一 PlanningAgent 配置发布、只读 Workspace、Requirement Release 冻结、TestCase v3/Repair v3、显式 Requirement Coverage、正式资产投影、用例库发布、UI/API 执行交接、确定性单 Run 报告指标与导出、PostgreSQL 只读报告快照、检索降级、FindingAction 并发控制和参数 Hash 审批。

## 接口摘要

- `POST /api/default-knowledge-base`
- `GET|POST /api/project-versions`
- `PATCH /api/project-versions/:id/status`
- `DELETE /api/project-versions/:id`
- `GET|POST /api/project-versions/:id/requirement-bindings`
- `DELETE /api/project-versions/:id/requirement-bindings/:bindingId`
- `GET /api/local-models`
- `GET /api/local-model/status`
- `POST /api/local-model/start`
- `POST /api/local-model/stop`
- `GET|POST|PUT /api/model-sources`
- `PATCH|DELETE /api/model-sources/:id`
- `POST /api/model-sources/discover`
- `POST /api/model-sources/:sourceId/models/:modelId/probe`
- `GET /api/models`
- `GET /api/ai-resources`
- `POST /api/ai-resources/:kind`
- `PUT|DELETE /api/ai-resources/:kind/:id`（`kind` 为 `mcp`、`skill` 或 `tool`）
- `GET /api/ai-resources/tool/:id/source`
- `GET /api/agent-configurations/requirement-analysis`
- `PUT /api/agent-configurations/requirement-analysis/draft`
- `POST /api/agent-configurations/requirement-analysis/publish`
- `GET /api/agent-configurations/test-design`
- `PUT /api/agent-configurations/test-design/draft`
- `POST /api/agent-configurations/test-design/publish`
- `GET /api/agent-configuration-versions/:id`
- `POST|GET /api/project-versions/:id/requirement-analysis-runs`
- `GET /api/requirement-analysis-runs/:id`
- `POST /api/requirement-analysis-runs/:id/cancel`
- `GET /api/requirement-analysis-runs/:id/finding-actions`
- `POST /api/requirement-analysis-runs/:id/findings/:findingId/actions`
- `GET /api/requirement-analysis-runs/:id/approvals`
- `POST /api/tool-approvals/:id/decision`
- `GET /api/project-versions/:projectVersionId/requirement-analysis-runs/:runId/report.md`
- `GET /api/project-versions/:projectVersionId/test-designs/inputs`
- `GET|POST /api/project-versions/:projectVersionId/test-designs`
- `GET|POST /api/project-versions/:projectVersionId/test-designs/:testDesignId/runs`
- `GET /api/project-versions/:projectVersionId/test-designs/:testDesignId/runs/:runId`
- `GET /api/project-versions/:projectVersionId/test-designs/:testDesignId/runs/:runId/coverage-audits`
- `POST /api/project-versions/:projectVersionId/test-designs/:testDesignId/runs/:runId/actions/re-audit`
- `POST /api/project-versions/:projectVersionId/test-designs/:testDesignId/runs/:runId/test-case-set-versions`
- `POST /api/test-case-set-versions/:versionId/execution-handoffs`
- `GET /api/project-versions/:projectVersionId/test-reports`
- `GET /api/project-versions/:projectVersionId/test-reports/:runId`
- `GET /api/project-versions/:projectVersionId/test-reports/:runId/export.json`
- `GET /api/project-versions/:projectVersionId/test-reports/:runId/report.md`
- `GET /api/knowledge-bases/:id/overview`
- `GET|PUT /api/knowledge-bases/:id/config`
- `POST /api/knowledge-bases/:id/embedding/test`
- `POST /api/knowledge-bases/:id/uploads`
- `POST /api/knowledge-bases/:id/archives`
- `GET /api/knowledge-bases/:id/files/*`
- `GET /api/knowledge-bases/:id/assets`
- `DELETE /api/assets/:id`
- `GET /api/asset-versions/:id`
- `GET /api/knowledge-bases/:id/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/retry`
- `POST /api/tasks/:id/cancel`
- `POST /api/knowledge-bases/:id/search`
- `POST /api/knowledge-bases/:id/rebuild`

当前交付不包含技术方案生成、开放式多 Agent 协作、Git/代码分析、跨运行报告趋势，以及 PDF/Word/Excel/图片等专用解析能力。报告一期不新增数据库表或持久化报告快照：人工重试追加正式事实后会生成新的报告 Hash，但不会独立保留重试前文档；也不由 Agent 计算正式指标或生成发布建议。测试执行只支持服务端固定编排的三个隔离 Agent 与 OCI Playwright UI/API 自动化。

需求分析采用独立 Worker 后台运行：启动接口创建分析 Run + Job 后立即返回 `202`，页面通过运行记录轮询真实状态。刷新、切换页面或关闭浏览器不会取消 Agent；只有显式调用取消接口才会将运行和 Job 标记为取消并中断当前 Worker。URL 固定 `page=requirement-analysis + projectVersionId + analysisId + runId + view`，并可附带 `findingId/evidenceId`；失败重试沿用同一 `analysisId`，刷新、分享及浏览器前进/后退会恢复同一显式作用域。

需求分析不再提供独立评审问答 Agent、问答 API 或问答历史表；数据库迁移会删除旧问答记录及其 Agent 配置快照。右侧“Pi Agent”仅展示统一需求分析运行轨迹。Finding 处置通过带期望版本的追加式 FindingAction 保存，原始 Finding 不改写；报告由服务端按 `projectVersionId + runId` 从正式结果、固定输入、Evidence、降级和处置投影生成 Markdown，不包含候选输出、明文凭据或未脱敏日志。
