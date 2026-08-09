# SmartHub Phase 1 + Phase 2 + Phase 3 评审闭环 + Phase 4 测试设计后端

当前仓库已实现第一期资料接入与检索闭环、第二期需求评审闭环、第三期技术方案评审闭环和第四期测试设计闭环。第三期采用固定双阶段流水线：`TechnicalSolutionExtractionAgent` 从一至多份固定 `technical_design` 资产版本提取方案要点并由服务端固化 Evidence，`TechnicalSolutionReviewAgent` 再基于固定成功需求评审运行与冻结方案要点生成覆盖、Finding、统计和 Markdown 报告。九个 Agent 均拥有独立定义、模型路由、Prompt、工具协议和发布版本；PostgreSQL 模式下需求评审、技术方案评审和测试设计均可由独立 Job/Worker 队列执行，并持久化固定快照、阶段检查点、运行历史、人工处置和正式结果。

第四期已实现双依据严格输入、原子固定依据、确定性知识召回、四 Agent 固定 DAG、范围/测试点树双人工门禁、节点级租约 fencing、树与用例追加式 revision/ETag、结构化 UI/API 用例、数据需求、服务端覆盖审计、人工审核、不可变用例集发布、JSON/Markdown/Excel 导出、`test_case` 知识资产投影、项目用例目录、既有套件只读查询、冒烟候选、影响回归和三种执行交接。`TestDesignPage` 已接入真实任务创建、运行概览、工作流、人工门禁、各阶段产物、测试点树结构编辑与独立批准、用例新建/结构化编辑/审核、数据约束版本、Finding/待确认项处置、发布阻断修复、重新审计、不可变用例集发布与导出、项目用例库/套件、冒烟候选、影响回归及执行交接。第四期仍不创建真实测试数据、`TestPlanVersion` 或测试任务，不执行脚本，也不发布新的冒烟基线；这些由后续执行阶段基于真实结果和人工决定完成。

## 阶段文档

- [一期需求文档](需求文档/第一期-项目知识库构建与配置需求文档.md)
- [一期技术方案（含架构设计）](技术文档/第一期-项目知识库构建与配置技术文档.md)
- [第二期需求文档](需求文档/第二期-需求评审与大模型配置需求文档.md)
- [第二期技术方案](技术文档/第二期-需求评审与大模型配置技术文档.md)
- [第三期技术方案分析模块需求文档](需求文档/第三期-技术方案分析模块需求文档.md)
- [第三期技术方案分析模块技术文档](技术文档/第三期-技术方案分析模块技术文档.md)
- [第四期多 Agent 测试设计工作流需求文档](需求文档/第四期-多Agent测试设计工作流需求文档.md)
- [第四期多 Agent 测试设计工作流技术文档](技术文档/第四期-多Agent测试设计工作流技术文档.md)

## 已实现

- Phase 4 测试设计：迁移 15～19、四 Agent 配置与 Pi Runtime、原子固定快照、确定性召回、节点级 DAG/公平 Worker、双门禁、树/用例/数据/审计/发布、项目目录/套件/冒烟/回归/执行交接 API 与真实前端闭环；

- 平台固定服务一个 SmartHub 项目，启动时自动解析并复用该项目的默认知识库；前端不提供项目创建、项目选择或项目切换；
- 项目空间通过项目版本隔离：必须先创建或选择版本才能进入需求分析；版本可设为 `open`、`locked` 或 `archived`，后两种状态只读；新版本可选择只继承来源版本的需求绑定，不继承评审运行与对话；
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
- “系统管理 → 模型管理”已接入服务端 AI 资源目录：模型页维护 Base URL、API Key、模型、能力、启停与优先级，添加、编辑、启停和删除均即时保存；MCP、Skill、工具页同样可维护真实运行资源。随应用发布的内置 Tool 和 Skill 始终启用，管理页不允许关闭，服务端也会拒绝停用请求并自动修复历史停用状态；是否授权给具体 Agent 仍由 Agent 配置及必需能力约束决定。MCP Runtime 使用官方 TypeScript Client，通过 Streamable HTTP 或兼容 SSE 执行 `tools/list` 与 `tools/call`，并同时校验 Agent 发布快照、MCP 策略 Hash、服务白名单和 Tool 白名单；Bearer/OAuth Access Token 只按配置的环境变量名称从部署环境读取，不写入数据库。随应用发布的内置 Skill 位于 `server/skills`，当前包含 `system.query-local-ip` 和 `system.structured-summary` 示例；项目外置 Skill/Tool 分别位于 `ai/skills`、`ai/tools`，服务启动和目录读取时扫描，并默认每 1 秒自动重扫。外置 Skill 通过同目录 `skill.json` 登记；外置 Tool 可使用无 JSON 的单文件静态清单、`*.tool.json`、目录 `tool.json`、批量 `tools.json` 或 `package.json` 的 SmartHub 声明。管理页标记为“外置”，只允许启停，编辑或删除应修改文件。Skill ZIP、内置 Skill 或外置 Skill 都会按发布配置 Hash 读取 `SKILL.md` 并注入 Agent；可执行 Skill 还可在入口同目录提供 `skill-runtime.json`，显式声明 PowerShell 脚本及 GET/HEAD 网络 Origin。脚本和网络权限归属 Skill，不出现在可独立管理的 Tool 目录；选择 Skill 发布时服务端自动派生内部调用协议，并实施相对路径、参数、精确 Origin、无重定向、超时、取消、受限环境和 256 KB 结果上限。自定义 Tool 仍支持 `ai/tools`/`server/tools` 本地模块、HTTP JSON API 和 MCP；所有能力继续经过 Agent Tool 白名单、风险、调用次数与重复调用策略治理；
- “系统管理 → Agent 配置”已接入真实草稿、发布和不可变版本闭环：通过中文下拉框分别配置需求点提取 Agent、需求评审 Agent、评审问答 Agent、技术方案提取 Agent 与技术方案评审 Agent；每个 Agent 独立持久化默认/回退模型、温度、输出上限、请求超时、重试次数、系统提示词、Tool/MCP/Skill 选择和运行限制，并拥有独立 revision 与当前生效版本。页面不提供版本记录入口，历史不可变快照仅由服务端保留用于运行追溯。Agent 配置列出模型管理中可独立配置的 Tool、MCP、Skill；启用的非必需资源可自由添加或移除，协议必需项固定保留，停用项不能新增。选择 Skill 即授权其固定运行权限清单，脚本和网络内部协议由服务端自动固化，无需重复勾选 Tool。发布时固定包含执行配置 Hash 的 Toolset、MCP 版本与策略 Hash、Skill 版本与内容配置 Hash；发布前除资源和参数校验外，模型必须通过版本化 `model-probe/v2` 长上下文、结构化提交和工具调用质量门禁。运行时发现目录配置与发布快照漂移会拒绝加载对应扩展能力并记录安全事件；
- 声明 `tool_calling` 的生成式模型必须在健康探测中真实完成一次受控函数调用，普通文本响应不能冒充工具能力；五个 Agent 分别通过各自的结果提交工具提交协议结果，最终结果仍由应用服务复验；
- 检索支持逻辑路径筛选；结果绑定固定索引成员元数据、资产版本、标题路径、Chunk 和原文行号，页面按结果的 `assetVersionId` 打开只读证据版本；
- 需求分析上传支持 Markdown、TXT 和 ZIP；当前项目版本的文件统一入库到 `版本文档/{项目版本名}/需求文档/`，ZIP 保留包内子目录和图片相对路径；上传区展示文件读取、任务提交、解析/Embedding、向量索引发布和项目版本绑定的真实进度，成功结果展示 15 秒后自动收起，失败结果保留。等待窗口为 10 分钟，批量上传按资产独立绑定并反馈部分失败，避免后端仍在处理却被前端误报整体失败；上传完成的固定需求资产版本自动绑定到当前项目版本。评审接口按 `projectVersionId` 校验版本状态和需求绑定；正式 ReviewRun、固定快照、成功结果、失败/取消终态和安全执行事件持久化到 PostgreSQL/JSON，页面刷新后按项目版本恢复真实历史；
- AC-001～AC-009 自动化验收场景。

## 当前已实现的第三期技术方案评审流程

- “技术方案评审”创建页沿用需求分析的三栏工作台：左侧可直接上传 Markdown、TXT 或 ZIP 到 `版本文档/{项目版本名}/技术方案/`，等待真实入库/索引任务完成后刷新并自动勾选 ready 的 `technical_design` 资产版本；中间选择成功 ReviewRun 作为固定需求基线并确认一至十份固定输入，右侧恢复历史评审；
- `TechnicalSolutionExtractionAgent` 使用 `technical-solution-extraction/v1` 提交方案要点和原文线索，服务端生成 `TSP-*` 与 Evidence；`TechnicalSolutionReviewAgent` 使用 `technical-solution-review/v2` 只引用冻结 `RP-*` 与 `TSP-*`，服务端归一化模型语义并生成正式 ID、需求关系和覆盖统计；
- 正常正文以 `full_context` 投递，超长正文确定性切换 `segmented_context`；成功发布前强制校验 `InputDeliveryManifest`、固定输入 Hash、Evidence 唯一性及需求覆盖全量唯一；
- Evidence 仍以固定输入中的逐字原文为准；若模型提交“章节提示 + ... + 逐字片段”，服务端只提取并保存可唯一定位的连续原文，忽略同组冗余说明，歧义、越界或完全无法定位仍会结构化拒绝；
- PostgreSQL 使用 `technical_solution_reviews`、输入、Run、Job、正式结果、Coverage、Finding、Evidence、关系表和追加写 FindingAction；Worker 使用 lease、heartbeat、run token 与 fencing，支持排队、取消、有限重试和迟到结果隔离；
- 前端通过显式 `projectVersionId + technicalReviewId + runId` 恢复评审上下文，提供摘要、覆盖、Finding、风险、Evidence、历史运行、固定原文、人工处置与 Markdown 导出；项目版本或知识资产删除会保护活动运行并级联第三期数据；
- 本期边界不包含 Git、代码 Diff、代码生成、部署、测试执行、Agent 自由委派和通用多 Agent 编排。

本地开发默认通过 `.env.local` 的 `DATABASE_URL` 使用 PostgreSQL；项目、知识库、配置版本、资产、不可变版本、资产 Chunk、索引固定 Chunk、同步任务、模型来源、AI 资源目录、Agent 配置、ReviewRun/Job、技术方案正式结果以及 Phase 4 的 Workflow、Snapshot、树、用例 revision、数据需求、覆盖关系、用例集、套件和交接分别写入 `smarthub` schema。Phase 4 顶层 JSON 仅保留兼容回退，规范化事实表参与当前读写与删除生命周期。写事务在数据库锁内读取最新状态并只对变化实体执行 UPSERT/定向删除，不再全库 `TRUNCATE + 重写`。Chunk 向量使用 pgvector 的 `vector` 类型，并为默认384维模型建立 HNSW 余弦索引。首次连接时会安装可用的 `vector`、`pg_trgm` 扩展、自动建表或迁移旧向量。未配置 `DATABASE_URL` 时回退到 JSON 文件；JSON 开发模式仍直接执行评审，生产模式必须使用 PostgreSQL Worker。

生产 API 注入 SmartHub 内置模型运行池。知识库配置先选择来源，再选择该来源中的生效模型；本地模式下上传解析、索引重建和向量/混合检索均路由到所选模型，发现模型未运行时会自动拉取并启动，同时不会停止池内其他模型。单元测试通过运行时接口注入轻量测试模型，不下载大模型。

## 当前已实现的第二期双 Agent 需求分析流程

> 实现边界：`requirement-point-extraction/v5` 正文直传与“可选 `title` + `description` + `sourceTexts`”协议已实现。模型正常生成简洁标题，标题缺失或空白时服务端根据描述兜底；正常规模正文通过 `full_context` 在首轮完整投递，超长正文通过 `segmented_context` 确定性分批投递、隔离批次消息并最终跨批归并。模型不再维护其他结构化槽位、归并字段、资产版本、Chunk 或 Evidence 字段；服务端持久化输入包 Hash、批次 Hash 和 `InputDeliveryManifest`，跨全部固定输入检索原文并生成需求点 ID、Evidence ID、`evidenceRefs`、coverage 与 locator。旧 v1～v4 仅作为历史数据语义保留，不再创建新运行。

- 使用最新稳定的 `@earendil-works/pi-agent-core` 和 `@earendil-works/pi-ai`，实际版本由 `package-lock.json` 固定；
- 业务层只依赖 `AgentRuntime`，PI 包只出现在 `server/agent/pi-agent-runtime.ts`，后续可替换运行内核而不改需求评审服务；
- Agent 定义、提示词、Toolset、Skill、MCP 绑定、执行限制和内容 Hash 独立版本化并写入运行快照；需求点提取 Agent 与需求评审 Agent 分别维护模型路由和不可变版本，运行解析器同时固定两者各自的生效版本；任一 Agent 未发布时拒绝创建需求评审运行；
- 每次运行固定项目版本当前绑定的全部 requirement 资产版本、活动索引版本、两个 Agent 各自实际选中的模型、配置版本与 Agent 定义，不在运行中漂移到最新资料或草稿；每个 Agent 的默认模型不可用时只按该 Agent 已发布的回退顺序选择健康模型；
- `RequirementPointExtractionAgent` 注册 `knowledge.search`、`knowledge.read_chunk` 和 `requirement-points.submit_result`，但正常全文提取只向模型开放结果提交工具，防止模型把全文理解退化为逐 Chunk 读取；仅当某个需求点完全无法从 `sourceTexts` 建立 Evidence 时，才开放 search/read_chunk 进入定点修复窗口。`RequirementReviewAgent` 只开放 `review.submit_result`；
- 工具统一经过白名单、超时、调用次数和重复调用门禁，不向 Agent 暴露 Shell、文件系统或任意 HTTP；重复调用默认拒绝，只有 `knowledge.read_chunk` 可在达到阈值后重放一次本次执行已成功读取的固定结果，且不触发底层读取或消耗额度；读取/证据工具不得耗尽提取 Agent 的全部额度，最后 3 次调用独立保留给当前阶段的结果提交工具；
- `RequirementInputPlan` 根据模型上下文、输出预留、修正预留、Prompt/工具 Schema 和安全余量计算输入预算；`full_context` 包含完整文档边界与 Chunk 目录，存在排除范围时只投递范围内 Chunk；`segmented_context` 按稳定 Chunk 顺序打包，单批超预算或超过 24 批会明确失败；
- `requirement-points.submit_result` 接受 `requirement-point-extraction/v5`：每条需求点包含模型生成的可选 `title`、必填 `description` 和 `sourceTexts`。标题仅用于展示且具有服务端兜底，不参与失败门禁；服务端在本次全部固定输入中依次执行精确匹配、Markdown 可见文本映射、忽略 Markdown/空白/标点的规范检索、省略片段检索和候选召回；模糊召回保留 `[max(0.45, 最高分 - 0.08), 最高分]` 置信区间内的全部证据位置，同一原文存在多个固定位置时也全部保留。一条线索失败不会拖垮已有有效 Evidence，只有整个需求点完全无可用原文时才要求修复；
- `review.submit_result` 使用 `requirement-review/v3`：模型提交总体摘要和逐条 `analyses`，每条分析只通过一个 `requirementPointRef` 对应冻结需求点，并给出标题、类型、严重度、置信度、分析、影响和建议。服务端校验引用、去重并生成 Finding ID；展示字段偶发缺失或枚举不规范时使用确定性兜底，不反复退回，只有需求点引用不存在或分析内容为空才拒绝；
- ReviewRun 分别持久化两个 Agent 的模型可见对话、工具参数/返回和语义事件时间线，页面可在“需求点提取 / 需求评审”之间切换查看；同一 ReviewRun 被 Worker 自动重领或重试时，每个 attempt 还会独立冻结当前 Agent、状态、错误和阶段执行快照。需求点提取与需求评审各自形成独立的重试对话序列，切换 Agent 后只显示该 Agent 的“第 N / M 次”、错误、降级和事件，不再共用一组切换或由后一次覆盖前一次。历史数据若只保存过失败摘要，页面明确标注该次对话不可恢复。两个 Pi session id 包含各自 Agent key，不复用消息上下文。API 凭据、签名、图片二进制和模型隐藏思维不写入记录；单模型按发布配置有限重试，耗尽后仅对允许降级、能力和上下文满足的候选模型切换，并保存每次实际尝试和降级原因；
- 调用评审接口时先创建 `running` ReviewRun 和持久化 ReviewJob 后立即返回；独立 Worker 通过 lease、heartbeat、run token 和 fencing 执行，只有当前租约持有者可以冻结阶段结果或发布正式结果。Worker 失租约后任务可重新领取，超过次数或取消后进入明确终态，晚到结果不能覆盖。只有 `open` 项目版本允许物理删除；删除时级联移除该版本的需求绑定、已结束 ReviewRun、FindingAction、问答、审批和运行记录。存在 `running` ReviewRun 时必须先取消，`locked/archived` 版本不可物理删除。
- 提取结果通过独立校验后立即作为冻结阶段检查点持久化。若随后需求评审失败或取消，页面同时提供“重新需求评审”和“全部重跑”：前者创建新 ReviewRun，复用并重新校验原需求点、Evidence、coverage 与正文投递证明，只使用当前已发布的需求评审 Agent 执行评审；后者按当前项目版本的全部有效绑定和两个当前 Agent 配置，从需求点提取开始创建完整新运行。提取阶段失败时没有可复用检查点，只允许全部重跑；任何重跑都不覆盖原运行。

当前自动化测试已覆盖正常规模正文首轮直传、读取工具调用为 0、`sourceTexts` 跨固定输入检索、置信区间多证据召回、无效线索局部忽略、服务端需求点去重、Evidence ID/引用生成与共享证据去重、coverage 生成、投递清单校验、评审分析与需求点对应、模型字段保留和容错兜底，以及超长正文确定性切换 `segmented_context`。

运行前需要先创建一个状态为 `open` 的项目版本，在该版本上传或继承一份或多份 `ready` 的 requirement 固定资产版本，再到“系统管理 → 模型管理”让生成式模型通过 `model-probe/v2`。随后进入“Agent 配置”，通过下拉框分别选择需求点提取 Agent 和需求评审 Agent，为两者配置模型、提示词、工具与限制，并分别发布首个版本；需求分析页只读展示两个当前配置版本，不提供模型覆盖入口，新运行自动固定这两个版本。任一 Agent 未发布时不允许发起评审。启动 API 会验证并固定当前版本的全部需求绑定，持久化 ReviewRun/ReviewJob 后立即返回；Worker 先按提取 Agent 的模型和版本运行并冻结结果，再按评审 Agent 的独立模型和版本用全新会话启动评审，最终合并为正式结果，页面通过 ReviewRun 接口恢复并轮询两个阶段：

```powershell
$ErrorActionPreference = 'Stop'
$body = @{
  assetVersionIds = @('<ready requirement assetVersionId 1>', '<ready requirement assetVersionId 2>')
  focusAreas = @('状态与异常', '可测试性')
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8787/api/project-versions/<projectVersionId>/requirement-reviews/run' -ContentType 'application/json; charset=utf-8' -Body $body
```

## 本地运行

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

Skill 新建默认使用受控 ZIP 上传：压缩包最多 20 MB、200 个文件，单文件最多 5 MB、解压后总计最多 50 MB，并且必须且只能包含一个非空 UTF-8 `SKILL.md`。服务端校验 CRC，拒绝绝对路径、路径穿越、Windows 保留名、大小写冲突、符号链接与原生可执行文件，再原子解压到 `data/skills/{skillKey}/{version}`，记录压缩包 Hash、内容 Hash 和文件清单。已上传包的标识、版本、入口和包元数据不可原位覆盖；删除未被 Agent 引用的 Skill 时同步删除对应包目录。`ai/skills/{name}/skill.json` 至少声明 `key`、`name` 和 `version`，可声明 `description`、`entrypoint`（默认 `SKILL.md`）、`toolIds` 和 `tags`；目录内容共同参与 SHA-256。Agent 发布版本的 Skill 配置 Hash 包含内容 Hash，但上传或扫描本身不会执行包内脚本，也不会自动扩大工具权限。

保存来源后，点击模型名称会发起最小生成请求并持久化真实健康状态；“获取当前配置模型”对 OpenAI/OpenAI-compatible 来源请求服务端 `/models`。Anthropic 没有统一的标准模型列表接口，因此需手动注册模型，但可执行真实 `/v1/messages` 连通性探测。

进入“系统管理 → Agent 配置”后，使用顶部中文下拉框选择“需求点提取 Agent”“需求评审 Agent”“评审问答 Agent”“技术方案提取 Agent”或“技术方案评审 Agent”。页面只提供模型与路由、提示词、Tool/MCP/Skill 三类配置；Tool/MCP/Skill 页面在资源清单底部集中维护最大轮次、最大工具调用、总截止时间和推理强度。资源页一次展示模型管理中的三类完整目录和已选数量，必需项不可取消，其余启用项可按 Agent 自由勾选。点击“发布新版本”会先保存当前 Agent 草稿，再只发布该 Agent 的下一不可变版本。五个 Agent 的版本号和生效状态互不影响；发布会校验资源依赖及模型的 `model-probe/v2` 质量门禁。运行时只加载与发布 Toolset、Skill Hash 和 MCP Policy Hash 一致的能力；`write-reversible`/`write-high-risk` 会按参数 SHA-256 建立 Approval，运行记录窗口可批准或拒绝，高风险写操作必须逐次批准；参数变化、拒绝、过期、取消都会阻止执行。

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

测试覆盖项目版本需求绑定隔离、显式继承和只读状态门禁，以及真实 Token 计数、上传/Worker 队列、候选索引切换、远程 Embedding、生成式模型连接和 `model-probe/v2`、Agent 草稿/发布、需求与技术方案双阶段 Agent、检索降级、Reranker、不可变原文快照、固定版本 Evidence、PI Agent 工具循环、候选结果校验、ReviewRun 持久化、配置/Prompt/Toolset/Skill/MCP 快照、问答 Turn 持久化、FindingAction 并发控制、参数 Hash 审批和服务端报告导出。

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
- `GET /api/agent-configurations/technical-solution-analysis`
- `PUT /api/agent-configurations/technical-solution-analysis/draft`（`agentKey=technicalSolutionExtraction|technicalSolutionReview`）
- `POST /api/agent-configurations/technical-solution-analysis/publish`（分别发布提取与评审 Agent）
- `GET /api/agent-configuration-versions/:id`
- `POST /api/project-versions/:id/requirement-reviews/run`
- `GET /api/project-versions/:id/requirement-review-runs`
- `GET /api/requirement-review-runs/:id`
- `POST /api/requirement-review-runs/:id/cancel`
- `GET|POST /api/requirement-review-runs/:id/questions`
- `GET /api/requirement-review-runs/:id/finding-actions`
- `POST /api/requirement-review-runs/:id/findings/:findingId/actions`
- `GET /api/requirement-review-runs/:id/approvals`
- `POST /api/tool-approvals/:id/decision`
- `GET /api/project-versions/:projectVersionId/requirement-review-runs/:runId/report.md`
- `GET /api/project-versions/:projectVersionId/technical-solution-review-inputs/baselines`
- `GET /api/project-versions/:projectVersionId/technical-solution-review-inputs/solution-assets`
- `GET|POST /api/project-versions/:projectVersionId/technical-solution-reviews`
- `GET|POST /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs`
- `GET /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs/:runId`
- `POST /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs/:runId/cancel`
- `GET /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs/:runId/finding-actions`
- `POST /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs/:runId/findings/:findingId/actions`
- `GET /api/project-versions/:projectVersionId/technical-solution-reviews/:technicalReviewId/runs/:runId/report.md`
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

当前 Agent 交付不包含技术方案生成、多 Agent 协作、Git/代码分析、测试执行，以及 PDF/Word/Excel/图片等专用解析能力。

需求评审采用独立 Worker 后台运行：启动接口创建 `ReviewRun + ReviewJob` 后立即返回 `202`，页面通过运行记录轮询真实状态。刷新、切换页面或关闭浏览器不会取消 Agent；只有显式调用取消接口才会将运行和 Job 标记为取消并中断当前 Worker。URL 固定 `page + projectVersionId + reviewId + runId + view`，并可附带 `findingId/evidenceId`；失败重试沿用同一 `reviewId`，刷新、分享及浏览器前进/后退会恢复同一显式作用域。

评审问答只接受成功完成的 ReviewRun，并要求已发布独立的评审问答 Agent。每轮固定使用该运行的资产版本、评审结果和 Evidence 白名单，同时固定当前生效的问答 Agent 配置版本；问题、回答、引用、实际模型、Agent/Prompt/Toolset 引用、用量和脱敏失败摘要写入 ReviewQaSession/Turn，刷新后从服务端恢复。模型必须通过 `review_answer_submit` 返回答案、Evidence ID 引用和限制项；Skill、网页、MCP 或其他 Tool 的内容可用于辅助解释，但不能扩大 Evidence 白名单。Finding 处置通过带期望版本的追加式 FindingAction 保存，原始 Finding 不改写。报告由服务端按 `projectVersionId + runId` 从正式结果、固定输入、Evidence、降级和处置投影生成 Markdown，不包含候选输出、问答全文、明文凭据或未脱敏日志。
