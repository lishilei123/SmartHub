# SmartHub Phase 1 + Phase 2 ReviewRun M3

当前仓库已实现第一期资料接入与检索闭环，并按第二期技术方案完成可运行的双 Agent 流程：`RequirementPointExtractionAgent` 只从多文档固定输入提取原子需求点、固定 Evidence 和覆盖范围，`RequirementReviewAgent` 只读取已校验冻结的提取结果并生成 Finding、风险、建议和评审摘要。两个 Agent 使用独立定义、Prompt、工具协议、Pi 会话和运行记录；需求点视图只展示需求点与证据，不混入 Finding。Finding 人工处置和独立 Review Job/Worker 仍属于第二期后续 M3～M5，不由前端本地状态代替。

## 阶段文档

- [一期需求文档](需求文档/第一期-项目知识库构建与配置需求文档.md)
- [一期技术方案（含架构设计）](技术文档/第一期-项目知识库构建与配置技术文档.md)
- [第二期需求文档](需求文档/第二期-需求评审与大模型配置需求文档.md)
- [第二期技术方案](技术文档/第二期-需求评审与大模型配置技术文档.md)

## 已实现

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
- “系统管理 → 模型管理”已接入服务端 AI 资源目录：模型页维护 Base URL、API Key、模型、能力、启停与优先级，添加、编辑、启停和删除均即时保存，不再使用页面级“保存配置”；MCP、Skill、工具页同样可即时新增、编辑、启停和删除资源。MCP 仅登记 HTTP/S 服务、传输/鉴权类型和远程工具范围，Skill 可受控上传 ZIP 或兼容登记手动入口并显式选择依赖工具，工具按内置/本地/HTTP/MCP 来源、风险与超时独立治理；内置和本地工具可在页面中只读查看真实源码，本地工具源码路径只允许指向仓库内 `server/tools` 或 `ai/tools` 下的 TypeScript/JavaScript 文件。现有四个需求评审工具自动登记为不可删除的内置工具，并分别维护独立实现文件；`requirement-tools.ts` 只负责按 Agent 阶段组装注册表。资源目录持久化到 PostgreSQL/JSON，但登记 MCP、自定义工具或上传 Skill 包不等于已接入运行时；Agent 仍只能使用服务端实际注册并授权的能力；模型连接读取和保存响应可回显 Base URL，但不回显 API Key，编辑时 API Key 留空会保留数据库中的旧值；
- “系统管理 → Agent 配置”已接入真实草稿、发布和不可变版本闭环：通过中文下拉框分别配置需求点提取 Agent 与需求评审 Agent；每个 Agent 独立持久化默认/回退模型、温度、输出上限、请求超时、重试次数、系统提示词、Tool/MCP/Skill 选择和运行限制，并拥有独立 revision、生效版本和版本历史。Agent 配置直接列出模型管理中的完整 Tool、MCP、Skill 目录，不再按 Agent 使用硬编码的局部工具列表；启用的非必需资源可自由添加或移除，协议必需项固定保留，停用项不能新增。发布时固定 Toolset 版本 Hash、MCP 版本与策略 Hash、Skill 版本与配置 Hash；发布前校验全部选择仍存在且启用、模型健康/能力、必需提交工具和参数上限；
- 声明 `tool_calling` 的生成式模型必须在健康探测中真实完成一次受控函数调用，普通文本响应不能冒充工具能力；两个 Agent 未提交结果时分别强制选择 `requirement_points_submit_result` 或 `review_submit_result`；提交工具先执行对应阶段的独立预校验，无效候选把具体问题返回模型并允许修正后重新提交，最终结果仍由应用服务复验；
- 检索支持逻辑路径筛选；结果绑定固定索引成员元数据、资产版本、标题路径、Chunk 和原文行号，页面按结果的 `assetVersionId` 打开只读证据版本；
- 需求分析上传支持 Markdown、TXT 和 ZIP；当前项目版本的文件统一入库到 `版本文档/{项目版本名}/需求文档/`，ZIP 保留包内子目录和图片相对路径；上传区展示文件读取、任务提交、解析/Embedding、向量索引发布和项目版本绑定的真实进度，成功结果展示 15 秒后自动收起，失败结果保留。等待窗口为 10 分钟，批量上传按资产独立绑定并反馈部分失败，避免后端仍在处理却被前端误报整体失败；上传完成的固定需求资产版本自动绑定到当前项目版本。评审接口按 `projectVersionId` 校验版本状态和需求绑定；正式 ReviewRun、固定快照、成功结果、失败/取消终态和安全执行事件持久化到 PostgreSQL/JSON，页面刷新后按项目版本恢复真实历史；
- AC-001～AC-009 自动化验收场景。

本地开发默认通过 `.env.local` 的 `DATABASE_URL` 使用 PostgreSQL；项目、知识库、配置版本、资产、不可变版本、资产 Chunk、索引固定 Chunk、同步任务、模型来源、AI 资源目录、Agent 配置草稿/发布版本和需求评审运行分别写入 `smarthub` schema。写事务在数据库锁内读取最新状态并只对变化实体执行 UPSERT/定向删除，不再全库 `TRUNCATE + 重写`。Chunk 向量使用 pgvector 的 `vector` 类型，并为默认384维模型建立 HNSW 余弦索引。首次连接时会安装可用的 `vector`、`pg_trgm` 扩展、自动建表或迁移旧向量。未配置 `DATABASE_URL` 时回退到 JSON 文件和进程内精确检索。

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
- ReviewRun 分别持久化两个 Agent 的模型可见对话、工具参数/返回和语义事件时间线，页面可在“需求点提取 / 需求评审”之间切换查看。两个 Pi session id 包含各自 Agent key，不复用消息上下文。API 凭据、签名、图片二进制和模型隐藏思维不写入记录；结果提交请求遇到 429 或临时供应商错误时执行最多两次指数退避重试；
- 调用评审接口时先创建 `running` ReviewRun，独立校验通过后保存正式结果；模型、工具或校验失败以及客户端取消均保留终态和脱敏错误。API 服务成功监听后会把上一个服务进程遗留的 `running` ReviewRun 收口为 `REVIEW_RUN_INTERRUPTED` 失败态，避免热重载或进程重启后永久停在运行中。只有 `open` 项目版本允许物理删除；删除时级联移除该版本的需求绑定、已结束 ReviewRun、结果和双 Agent 运行记录。存在 `running` ReviewRun 时必须先取消，`locked/archived` 版本不可物理删除。

当前自动化测试已覆盖正常规模正文首轮直传、读取工具调用为 0、`sourceTexts` 跨固定输入检索、置信区间多证据召回、无效线索局部忽略、服务端需求点去重、Evidence ID/引用生成与共享证据去重、coverage 生成、投递清单校验、评审分析与需求点对应、模型字段保留和容错兜底，以及超长正文确定性切换 `segmented_context`。

运行前需要先创建一个状态为 `open` 的项目版本，在该版本上传或继承一份或多份 `ready` 的 requirement 固定资产版本，再到“系统管理 → 模型管理”配置并探测启用 `tool_calling` 能力的生成式模型。随后进入“Agent 配置”，通过下拉框分别选择需求点提取 Agent 和需求评审 Agent，为两者配置模型、提示词、工具与限制，并分别发布首个版本；需求分析页只读展示两个当前配置版本，不提供模型覆盖入口，新运行自动固定这两个版本。任一 Agent 未发布时不允许发起评审。启动 API 会验证并固定当前版本的全部需求绑定，持久化 ReviewRun 后立即返回；服务端先按提取 Agent 的模型和版本运行并冻结结果，再按评审 Agent 的独立模型和版本用全新会话启动评审，最终合并为正式结果，页面通过 ReviewRun 接口恢复并轮询两个阶段：

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

Skill 新建默认使用受控 ZIP 上传：压缩包最多 20 MB、200 个文件，单文件最多 5 MB、解压后总计最多 50 MB，并且必须且只能包含一个非空 UTF-8 `SKILL.md`。服务端校验 CRC，拒绝绝对路径、路径穿越、Windows 保留名、大小写冲突、符号链接与原生可执行文件，再原子解压到 `data/skills/{skillKey}/{version}`，记录压缩包 Hash、内容 Hash 和文件清单。已上传包的标识、版本、入口和包元数据不可原位覆盖；删除未被 Agent 引用的 Skill 时同步删除对应包目录。Agent 发布版本的 Skill 配置 Hash 包含内容 Hash，但上传本身不会执行包内脚本，也不会自动扩大工具权限。

保存来源后，点击模型名称会发起最小生成请求并持久化真实健康状态；“获取当前配置模型”对 OpenAI/OpenAI-compatible 来源请求服务端 `/models`。Anthropic 没有统一的标准模型列表接口，因此需手动注册模型，但可执行真实 `/v1/messages` 连通性探测。

进入“系统管理 → Agent 配置”后，使用顶部中文下拉框选择“需求点提取 Agent”或“需求评审 Agent”。模型与路由、提示词、Tool/MCP/Skill、版本记录均随当前选中的 Agent 切换；资源页一次展示模型管理中的三类完整目录和已选数量，必需项不可取消，其余启用项可按 Agent 自由勾选。点击“发布新版本”会先保存当前 Agent 草稿，再只发布该 Agent 的下一不可变版本。两个 Agent 的版本号和生效状态互不影响；发布会校验所选资源仍存在且启用、当前 Agent 的默认及启用回退模型已经健康探测、具备工具调用/所选结构化输出能力，且输出 Token 不超过模型上限。目录绑定不会绕过运行时：只有已注册 Handler 的 Tool 才会暴露给模型，尚未接入的 Tool/MCP 会保留在版本快照中并显示“待接入”，不会导致整个 Agent 运行失败。

## 验证

```powershell
$ErrorActionPreference = 'Stop'
npm test
npm run build
```

测试覆盖项目版本需求绑定隔离、显式继承和只读状态门禁，以及真实 Token 计数、最大长度、重叠和代码块保护、上传入队、处理中取消、候选索引切换、重复上传短路、局部 Chunk 复用、远程 Embedding 请求与失败语义、生成式模型连接的持久化/掩码读取/留空保留/发现/探测、Agent 草稿并发控制/发布校验/不可变版本、检索自动降级、两路召回数量、Reranker、系统默认目录落盘、不可变原文快照、失败保留旧索引、固定版本证据、配置重建，以及 PI Agent 真实工具循环、候选结果提交、独立校验、ReviewRun 成功/失败持久化和配置/Prompt/Toolset/Skill/MCP 版本快照。

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
- `GET /api/agent-configuration-versions/:id`
- `POST /api/project-versions/:id/requirement-reviews/run`
- `GET /api/project-versions/:id/requirement-review-runs`
- `GET /api/requirement-review-runs/:id`
- `POST /api/requirement-review-runs/:id/cancel`
- `POST /api/requirement-review-runs/:id/questions`
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

需求评审采用服务端后台运行：启动接口创建 `ReviewRun` 后立即返回 `202`，页面通过运行记录轮询真实状态。刷新、切换页面或关闭浏览器不会取消 Agent；只有显式调用取消接口才会将该运行标记为 `cancelled` 并中断当前执行。当前 Agent 执行仍驻留在 API 服务进程内，服务热重载或进程重启会把遗留运行标记为可重新发起的明确失败态；持久化 Worker 租约恢复属于后续交付，当前不伪装为断点续跑。

评审问答只接受成功完成的 ReviewRun，固定使用该运行的资产版本、评审结果、Evidence 白名单和模型连接。问答模型必须通过 `review_answer_submit` 返回答案、Evidence ID 引用和限制项；服务端拒绝不属于该 ReviewRun 的引用。`ReviewQaRuntime` 与 Pi 适配器分离，为后续独立 Prompt、Skill、MCP 和工具策略保留替换边界。
