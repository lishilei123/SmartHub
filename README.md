# SmartHub

面向软件测试全流程的 AI 自动化平台，将知识库、需求分析、测试设计、测试执行和报告诊断连接为一条可追溯的工程闭环。

SmartHub 使用 Pi Agent 完成理解、推理和候选生成，由 Service、Validator、Workflow 与 Runner 管理正式状态和确定性规则。项目版本、发布内容、运行快照、测试脚本修订和执行证据由服务端固化，避免把 Agent 输出直接当作业务事实。

> [!IMPORTANT]
> 项目仍处于持续开发阶段。核心流程已经接入真实 API、PostgreSQL、Agent Runtime 与 Playwright Runner，但生产部署仍需要可信身份认证适配器、独立 PostgreSQL 和外部持久化数据目录。

## 目录

- [核心能力](#核心能力)
- [工作流程](#工作流程)
- [架构与数据边界](#架构与数据边界)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [首次使用](#首次使用)
- [配置](#配置)
- [生产构建与运行](#生产构建与运行)
- [开发与验证](#开发与验证)
- [项目结构](#项目结构)
- [扩展能力](#扩展能力)
- [API 概览](#api-概览)
- [当前边界](#当前边界)
- [贡献](#贡献)
- [许可协议](#许可协议)

## 核心能力

| 模块 | 能力 |
| --- | --- |
| 知识库 | Markdown、TXT 与 ZIP 资料接入；不可变资产版本；关键词、向量和混合检索；本地或远程 Embedding 与 Reranker。 |
| 需求分析 | `PlanningAgent` 在只读 Project Workspace 中自主检索资料，生成需求、证据和待澄清项；Service 校验后发布不可变 Requirement Release。 |
| 测试设计 | 基于当前 Release 和显式继承的历史基线生成 Candidate Delta；由 Service 完成匹配、覆盖审计、人工审核和正式用例库发布。 |
| 测试执行 | 从正式用例库创建 Run，优先执行有效 Execution Binding；缺少实现时由受控 Agent 生成或修复 Playwright 脚本，再由本地 Runner 真实执行。 |
| 报告与诊断 | 从 Run、Task、Attempt、ExecutionEvent 和 Artifact 等正式事实确定性生成指标、失败诊断及 JSON/Markdown 报告。 |
| AI 资源治理 | 版本化管理模型、Agent、Prompt、Tool、MCP、Skill、权限和内容 Hash；运行时冻结发布配置，拒绝静默漂移。 |

## 工作流程

```mermaid
flowchart LR
    A[资料与产品原型] --> B[知识库与版本工作区]
    B --> C[PlanningAgent 需求分析]
    C --> D[Requirement Release]
    D --> E[测试设计与覆盖审计]
    E --> F[正式 Test Case Library]
    F --> G[Execution Binding / 实现 Agent]
    G --> H[Playwright Runner]
    H --> I[执行事件与产物]
    I --> J[报告与诊断]
```

需求分析与测试设计复用同一个 ProjectVersion Planning Session，保持语义连续；下游正式输入始终从已发布 Release、Version 和 Snapshot 重新读取。测试执行使用独立的受控 Session，并将 Agent 实现、确定性校验和真实 Runner 执行分离。

## 架构与数据边界

SmartHub 遵循以下职责边界：

- **Agent**：理解上下文、推理并生成候选，不直接修改正式业务状态。
- **Workflow**：推进 Stage、控制可用 Tool 和人工 Gate。
- **Service**：拥有状态流转、版本、发布、重试和审计决策。
- **Validator**：执行 Schema、引用、路径、Hash、Binding 和安全规则校验。
- **Runner**：通过 Playwright 执行真实 UI/API 测试并产生结构化结果。
- **PostgreSQL**：保存 ProjectVersion、Release、Run、Revision、Attempt、Event 等正式事实。
- **Artifact Store**：保存不可变脚本、截图、Trace、Video 和导出产物。

核心原则是：**Agent 负责智能，Service 负责治理；上下文可以压缩，正式事实必须可重新读取和验证。**

### Project Workspace

每个项目版本拥有独立的逻辑工作区。显式继承可以复制需求绑定、Execution Workspace、Binding 和脱敏后的 Exploration Context，但目标版本必须独立验证；运行期认证状态不会继承。

```text
/workspace/
├── branches/{version}/
│   ├── input/{requirements,api,ui,environment}/
│   ├── test_design/
│   ├── test_cases/
│   ├── scripts/
│   ├── execution/
│   └── reports/
├── shared/{knowledge,common_scripts,common_docs}/
└── agent_workspace/{requirement_agent,design_agent,execution_agent,report_agent}/
```

### 测试执行

- UI Case 和 API Case 共用 TypeScript + Playwright Test Workspace，不存在单独的 APIRunner。
- UI Case 必须使用 `page` 验证 UI 目标；API Case 使用 Playwright `request` / `APIRequestContext`。
- Execution Binding 固定 `Case → entryFile → entrySymbol`，并校验 Case 内容、执行方式、入口和依赖闭包 Hash。
- 有效 Binding 先执行；Binding 缺失或失效时，按 Existing Workspace、Exploration Context、Knowledge、受控 Browser Exploration 的顺序补齐实现信息。
- Runner 只消费 Playwright JSON Reporter 的结构化结果，不把 Agent 自然语言过程或原始 CLI 输出当作执行证据。
- HTTP Timeline 仅把 `test.step` 完成表达为“已返回”，并从 Playwright Trace 的结构化 Network 记录补充状态码；失败结果与 Screenshot/Trace/Video 产物各保留一个 Timeline 节点。

## 技术栈

| 层级 | 主要技术 |
| --- | --- |
| Web | React、TypeScript、Vite |
| API / Worker | Node.js、TypeScript |
| Agent Runtime | Pi Agent Core、Pi AI、Pi Coding Agent |
| 数据库 | PostgreSQL、pgvector、pg_trgm |
| 自动化执行 | Playwright Test |
| 协议与扩展 | MCP、受控 Skill、内置/外置 Tool |

依赖的精确版本由 [`package-lock.json`](package-lock.json) 固定。

## 快速开始

### 环境要求

- PowerShell 7（`pwsh`）
- Node.js `>= 22.19.0`
- npm
- 推荐 PostgreSQL，并安装可用的 `pgvector` 扩展
- 至少一个可用的生成式模型；需要知识库向量检索时还需配置本地或远程 Embedding 模型

未配置 `DATABASE_URL` 时，开发环境可以回退到单进程 JSON Store；独立 Worker 和生产模式必须使用 PostgreSQL。

### 1. 安装依赖

```powershell
$ErrorActionPreference = 'Stop'
npm ci
npx playwright install chromium
```

### 2. 创建本地配置

```powershell
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath '.env.local')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
}
```

编辑 `.env.local`，至少填写已存在的 PostgreSQL 数据库连接：

```dotenv
DATABASE_URL=postgresql://postgres:<password>@localhost:5432/smarthub
```

`.env.local` 不应提交到 Git。迁移会创建所需扩展和 `smarthub` Schema；数据库用户需要具备相应权限。

### 3. 执行数据库迁移

```powershell
$ErrorActionPreference = 'Stop'
npm run migrate
```

### 4. 启动开发环境

```powershell
$ErrorActionPreference = 'Stop'
npm run dev
```

该命令同时启动 API、Worker 和 Web：

| 服务 | 地址 |
| --- | --- |
| Web | <http://127.0.0.1:5173> |
| API | <http://127.0.0.1:8787> |
| 健康检查 | <http://127.0.0.1:8787/api/health> |

前端 API、文档图片、报告与 Artifact 下载统一默认请求同源 `/api`。Vite 开发和预览服务将其代理到 `http://127.0.0.1:8787`，可用 `SMART_HUB_DEV_API_TARGET` 调整代理目标。部署静态页面时，请由 Web 反向代理将 `/api` 转发到 API 服务；跨域部署可在构建前配置 `VITE_API_BASE=https://api.example.com/api`。旧 `VITE_PLANNING_API_BASE` 仅作为统一地址的兼容回退，建议迁移到 `VITE_API_BASE`。

开发脚本会先检查 `5173` 和 `8787` 端口。若完整实例已经运行，它不会重复启动 Worker；若端口被其他进程占用，则会显示占用信息并退出。

## 首次使用

1. 在左侧版本入口创建状态为 `open` 的项目版本。
2. 在需求分析中上传至少一份 Markdown/TXT 需求文档，并等待索引任务完成。
3. 在“系统管理 → 模型管理”添加并探测生成式模型。
4. 在“系统管理 → Agent 配置”完成 `PlanningAgent` 与测试执行 Agent 配置并发布。
5. 在“系统管理 → 知识库配置”选择 Embedding 来源与模型。
6. 返回项目版本，依次完成需求分析、澄清、测试设计审核、正式用例库发布和测试执行。

测试执行当前仅支持 Worker 所在机器上的本地 Playwright Runner，OCI Runner 尚未接入运行链路，系统管理已收起对应环境、镜像与网络配置入口。当前 Run 冻结最新正式用例库并全量执行，全部用例均须通过执行就绪校验，否则阻止创建 Run；冒烟、回归与自定义套件的维护和发布继续保留，分类执行后续接入。

本地模型由 API 进程直接运行，不要求安装 Ollama；远程 Embedding 同时支持 OpenAI-compatible 接口和 Ollama 原生接口。

## 配置

常用环境变量如下，完整示例见 [`.env.example`](.env.example)。

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接；生产环境必填。 |
| `SMARTHUB_APP_ROOT` | 应用根目录。 |
| `SMARTHUB_DATA_ROOT` | 模型、文档、Skill 等可写数据的统一根目录。 |
| `SMARTHUB_DATA_FILE` | JSON 开发回退文件，仅适用于未使用 PostgreSQL 的单进程场景。 |
| `SMARTHUB_MODEL_ROOT` | 本地模型缓存目录。 |
| `SMARTHUB_DOCUMENT_ROOT` | 知识库当前文件与不可变版本目录。 |
| `SMARTHUB_SKILL_ROOT` | 上传 Skill 包的存储目录。 |
| `SMARTHUB_MODEL_HUB` | Hugging Face-compatible 主模型仓库。 |
| `SMARTHUB_MODEL_HUB_FALLBACK` | 主仓库发生网络错误时使用的备用镜像；空字符串可关闭。 |
| `SMARTHUB_BOOTSTRAP_SUBJECT_ID` | 仅用于开发环境的启动身份。 |
| `SMARTHUB_BOOTSTRAP_DISPLAY_NAME` | 仅用于开发环境的启动身份名称。 |
| `SMARTHUB_TRUSTED_PROXY_SECRET` | 生产 API 与可信反向代理之间的共享密钥，至少 32 字节；Worker 不需要。 |

默认可写目录位于 `data/`。生产部署应使用 `SMARTHUB_DATA_ROOT` 将其放到应用包之外，并在升级时同时保留 PostgreSQL 和外部数据目录。

### 凭据与敏感数据

- MCP 和 HTTP Tool 的 Token 仅通过资源配置引用的环境变量注入，不写入数据库。
- 模型来源的 Base URL 与 API Key 作为配置值保存在数据库中；读取接口不会回显 API Key。生产环境必须限制数据库访问并使用受控备份。
- Execution Workspace、Revision、Artifact 和 Exploration Context 不保存真实 Authorization、Cookie、Token、账号或原始请求/响应 Body。
- Playwright 登录态仅存在于 Run-scoped 临时目录，运行终态后清理，也不会进入版本继承。
- 普通受保护业务 Case 在 Runner 前由 Browser Gateway 复用或准备同源登录态；只有登录成功证据通过且 `storageState` 完成作用域校验后，Runner 才会加载。登录入口、受管凭据或成功证据缺失时，Task 在真实 Attempt 前进入人工处理，不会以匿名请求制造 401 和自动修复重试。
- 开发启动身份不能替代生产认证。生产 API 默认要求可信反向代理：代理必须移除客户端传入的 `x-smarthub-*` Header，在完成身份认证后注入 `x-smarthub-proxy-secret`、`x-smarthub-subject-id` 和 `x-smarthub-display-name`。API 继续只监听 loopback；第一版仅完成认证，细粒度 RBAC 后续接入。

## 生产构建与运行

生产 API 会从 `dist/` 提供前端资源和 SPA fallback；API 与 Worker 共用 `dist-server/` 产物。

先安装依赖、迁移、构建，再裁剪开发依赖：

```powershell
$ErrorActionPreference = 'Stop'
npm ci
npm run migrate
npm run build
npm prune --omit=dev
```

随后使用进程管理器分别启动 API 和 Worker：

```powershell
$ErrorActionPreference = 'Stop'
npm run start:api:dist
```

```powershell
$ErrorActionPreference = 'Stop'
npm run start:worker:dist
```

生产模式必须提供 `DATABASE_URL`；API 还必须提供 `SMARTHUB_TRUSTED_PROXY_SECRET`，Worker 不读取该变量。API 与 Worker 应使用相同的应用产物、数据库配置和外部数据根目录。

## 开发与验证

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 watch 模式 API、稳定 Worker 和 Vite Web；Worker 不随源码变更重启。 |
| `npm run dev:web` | 只启动 Web。 |
| `npm run dev:api` | 以 watch 模式启动 API。 |
| `npm run dev:worker` | 启动稳定 Worker；应在没有运行中任务时手动重启以加载代码变更。 |
| `npm test` | 运行 TypeScript 单元与服务测试。 |
| `npm run test:postgres` | 运行 PostgreSQL 集成测试。 |
| `npm run build` | 构建前端和服务端。 |
| `npm run format` | 格式化 App、测试设计 Service 及本轮拆出的职责模块。 |
| `npm run format:check` | 检查上述模块的格式，不改写文件。 |
| `npm run migrate` | 执行 PostgreSQL 迁移。 |

Worker 将测试执行与需求分析、测试设计、知识库队列隔离。测试执行的 Runner 和 Agent 使用独立容量：**Runner 默认 3（1～16），Agent 默认 1（1～8）**，统一定义于 `server/domain/test-execution-infrastructure-configuration.ts`。入口为 **系统设置 → 测试执行配置 → 并发控制**，支持保存服务端草稿、发布配置，并展示当前生效值、来源、版本、发布时间和发布人。草稿不影响调度；历史发布版本缺少并发字段时读取代码默认值，不改写历史内容或 Hash。

Worker 启动时读取 PostgreSQL 已发布配置，随后每 5 秒定向查询当前版本；读取失败保留最近有效容量。调高容量允许新领取任务；调低时已开始任务自然完成，不取消或重启 Worker，运行中数量低于新上限后才继续领取。并发配置只影响调度速度，不改变测试结果和业务事实。测试执行不再读取旧 `SMARTHUB_TEST_EXECUTION_CONCURRENCY`，也不使用 Runner/Agent 并发环境变量。其余工作流仍由 `SMARTHUB_WORKFLOW_CONCURRENCY` 控制（默认 1，范围 1～8），旧 `SMARTHUB_WORKER_CONCURRENCY` 仅作为该工作流的兼容回退。

任务资源类型由已有持久化 Task 状态投影为 `ExecutionResourceClass`：

| 阶段 | 资源与处理 |
| --- | --- |
| `pending` | 独立单槽预检执行确定性 Binding / Workspace 校验；有效入口及依赖闭包形成不可变执行包后交给 Runner，无 Agent 调用。 |
| `ready` / `retrying` | Runner 槽位准备受管 Run 认证状态，并真实执行 Playwright。 |
| `script_generating` | Agent 槽位处理缺失或失效 Binding、受控页面探索和候选生成。 |
| `diagnosing` / `repairing` | Agent 槽位业务诊断或预算内脚本修复；Validator 校验后交回 Runner。 |

预检通道只处理元数据和 Workspace 校验，不执行 Playwright 或调用 Agent；即使 Runner 全满，新 Case 仍能被分流到 Agent。阶段资源改变或预检完成时，Service 在有效租约和 Fencing Token 下把原 Job 重新入队，释放当前槽位，下一资源有容量时才领取。交接退还本次领取计数，保留真正异常的重试计数、退避、Repair 上限和取消治理。领取使用 SQL 状态过滤及索引，不加载完整数据库状态，也不持有数据库租约等待另一类容量。Migration 45 增加领取索引、交接约束、并发配置草稿表及数值范围约束。

这是**共享持久化 Job 队列上的两类独立调度容量**，没有新建两张物理队列表。容量目前按单个 Worker 进程生效，多 Worker 总容量会叠加；跨 Worker 全局资源配额与跨进程 Workspace 文件锁仍需后续实现，目前同一 Workspace 应由一个 Worker 进程管理。运行中 Attempt 使用冻结 Revision 的执行包，后续 Workspace 写入不改变其内容。Workspace 文件与 PostgreSQL 尚非跨介质原子事务，候选文件发布受租约保护并标记 `needs_validation`，真实通过后才在 Workspace 锁内核对入口和依赖 Hash 并升级 Binding；旧 PASS 不覆盖较新候选。

FailureAnalysisAgent 只分析结构化 Attempt/Event、脱敏日志和 Screenshot/Trace/HTTP 证据，提出类别、修复建议或人工处理建议。它不能把失败改为通过、覆盖正式 Revision、更新 Binding、删除核心断言或弱化业务预期。明确网络不可达、受管认证/配置错误和数据未就绪由确定性规则优先收口；Runner 基础设施异常保留有限退避重试。裸 401/403、一般超时或证据不足不会被强行归因为认证失败或产品缺陷。Service 拥有最终状态及修复预算；修复保留旧 Revision，创建新候选，通过 Validator 后必须再次由 Runner 真实执行。

### Playwright Generator 可行性

当前锁定 `@playwright/test` / Playwright 1.58.2 和 `@playwright/cli` 0.1.18。官方 [codegen](https://playwright.dev/docs/codegen) 主要提供交互式录制；[Test Agents](https://playwright.dev/docs/test-agents) 提供 Agent 定义及工具工作流，未提供适合当前 CLI-first 服务端直接嵌入的稳定 Generator SDK。因此本轮**未接入完整官方 Generator**，未调用内部模块、创建空 Adapter 或增加不可用页面按钮，正式 Generator 集成留待公开接口和运行模式匹配后再评估。

现有受控 Browser Exploration 已使用[官方 CLI](https://github.com/microsoft/playwright-cli) 的 `snapshot`、`generate-locator`、点击、填写及截图等能力；本轮强化生成和 Repair 的 Locator 顺序：`getByRole → getByLabel → getByPlaceholder → getByTestId → 稳定文本 → 稳定 CSS → XPath`，所有 Locator 必须来自真实页面证据，CLI 不可用时明确失败。候选仍走 Agent → Validator（路径、依赖、敏感信息和断言校验）→ 新 Revision → Runner → Service 验证 Binding 的现有闭环。真实模型、生产浏览器/SSO及多 Worker 负载仍需独立环境验收。
PostgreSQL 集成测试必须使用独立测试库，且数据库名称需要包含 `test`：

```powershell
$ErrorActionPreference = 'Stop'
$env:TEST_DATABASE_URL = 'postgresql://postgres:<password>@localhost:5432/smarthub_test'
try {
  npm run test:postgres
} finally {
  Remove-Item Env:TEST_DATABASE_URL
}
```

提交变更前至少执行：

```powershell
$ErrorActionPreference = 'Stop'
npm test
npm run build
git diff --check
```

## 项目结构

```text
SmartHub/
├── src/                    # React 前端与页面级 API Client
├── server/
│   ├── agent/              # Agent Runtime 与会话集成
│   ├── application/        # 业务 Service 与用例编排
│   ├── domain/             # 领域模型和确定性规则
│   ├── http/               # HTTP API 与访问控制
│   ├── infrastructure/     # PostgreSQL、迁移、存储和外部适配器
│   ├── runner/             # 本地 Workspace Runner
│   ├── skills/             # 内置 Skill
│   └── tools/              # 内置 Tool
├── ai/skills/              # 文件系统外置 Skill
├── ai/tools/               # 文件系统外置 Tool
├── scripts/                # PowerShell 开发脚本
├── tests/                  # 单元、服务与 PostgreSQL 集成测试
└── data/                   # 默认本地运行数据（不要作为正式源码提交）
```

## 页面与测试设计代码边界

`src/App.tsx` 负责应用壳、路由、当前项目版本和共享知识库状态；页面内容在 `src/app/`：`Documents` 管理知识库文档，`SystemSettings` 组织系统配置，模型、Agent、AI 资源和知识库配置各有独立模块。公共组件与类型由 `shared.tsx`、`settings-shared.tsx` 和 `types.ts` 提供，页面不反向依赖 App。

`server/application/test-design-service.ts` 保留公开 Service 入口、Store 事务、调度和资产投影。`test-design/` 下的 `workflow.ts` 负责候选生成与修复编排，`case-review.ts` 负责 Revision、审核和 Proposal 规则，`library.ts` 负责发布校验、冻结成员和追溯，`snapshots.ts` 负责需求、历史和检索快照，`suites.ts` 负责套件规则，`state.ts` 提供状态访问和公共校验。这些模块在现有 Service 事务中工作，不独立写入正式状态；已有公共导出仍由 Service 文件提供。

格式化命令暂时只覆盖上述模块，避免一次性改写全仓库。后续可继续按业务边界提取大型页面内的面板和 Service 操作，保持原有审核、发布及不可变版本约束。

## 扩展能力

- 内置能力随应用发布，分别位于 `server/skills` 和 `server/tools`。
- 外置 Skill 放在 `ai/skills/{name}`，通过 `skill.json` 登记，并以 `SKILL.md` 作为默认入口。
- 外置 Tool 放在 `ai/tools`，支持静态模块清单或独立 JSON 描述文件；最小示例见 [`ai/tools/example-echo.ts`](ai/tools/example-echo.ts)。
- MCP、HTTP Tool 和本地 Tool 都必须经过 Agent 发布快照、白名单、风险、调用次数和配置 Hash 校验。
- 已发布 Agent 绑定的 Tool/Skill 内容发生漂移时，运行时会拒绝静默加载，需要管理员重新发布配置。

## API 概览

HTTP API 默认使用 `/api` 前缀，主要资源包括：

- `/api/project-versions`：项目版本、状态和继承关系。
- `/api/knowledge-bases`、`/api/assets`：资料、版本、索引和检索。
- `/api/requirement-analysis-runs`：需求分析运行、澄清、审批与报告。
- `/api/project-versions/:id/test-designs`：测试设计、运行和覆盖审计。
- `/api/test-case-set-versions`：正式用例库与执行交接。
- `/api/project-versions/:id/test-execution-runs`：测试执行 Run、Task、Attempt 和 Artifact。
- `/api/project-versions/:id/test-reports`：确定性报告与导出。
- `/api/ai-resources`、`/api/agent-configurations`：模型、Tool、MCP、Skill 和 Agent 发布配置。

接口以 `server/http` 中的当前实现为准。

## 当前边界

当前版本不包含以下能力：

- 技术方案自动生成。
- 开放式多 Agent 协作。
- Git 仓库或源代码分析。
- 跨执行 Run 的趋势报告。
- PDF、Word、Excel、图片等格式的专用内容解析。

测试执行只消费正式 Test Case Library 中已有的 UI/API Case；Exploration 用于补足执行上下文，不会扩大测试设计范围。报告由服务端从正式执行事实确定性生成，不由 Agent 计算正式指标或发布建议。

## 贡献

欢迎通过 Issue 或 Pull Request 参与改进。提交前请遵循以下原则：

1. 先理解现有 Runtime、Service、Validator、Workspace、Version/Snapshot 和 Tool Governance，再做增量修改。
2. 确定性业务规则放在 Service 或 Validator，不依赖 Prompt 兜底。
3. 不覆盖已发布 Release、Library、Run、Revision 或 Artifact 的历史事实。
4. 不使用模拟数据冒充真实模型、数据库、浏览器或 Runner 能力。
5. 在 Pull Request 中说明修改范围、迁移影响、验证结果以及尚未执行的 PostgreSQL、浏览器或模型 E2E。

## 许可协议

当前仓库尚未提供 `LICENSE` 文件，因此暂未授予明确的开源使用、修改和分发许可。正式公开发布前，请由项目维护者选择并添加合适的开源许可证。
