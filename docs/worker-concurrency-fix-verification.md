# Worker 停止语义与并发修复验证

本文保留 2026-09-05 修复阶段的历史实现与本地验证事实；下文第 1～9 节的“本轮”、基线、文件列表和测试数量均指当时。原“未创建提交、未推送远端、修订后 CI 尚未运行”仅为当时状态，不是当前结论。

## 当前 HEAD 的远端 CI（2026-09-05 查询）

- 本地 HEAD 与远端最新 `PI-Agent` 均为 `b3287cb960e2935bd1e7ea091b03b5f70f8152ee`（通过 `git ls-remote` 核对）。
- 查询时间：2026-09-05 23:48（UTC+08:00）。GitHub Actions API 按完整 `head_sha` 查询，事件为 `push`，未借用其他提交结果。
- [CI Run 33974681715](https://github.com/lishilei123/SmartHub/actions/runs/33974681715)：`completed / success`；[tests](https://github.com/lishilei123/SmartHub/actions/runs/33974681715/job/101329193317)、[build](https://github.com/lishilei123/SmartHub/actions/runs/33974681715/job/101329193384)、[postgres-integration](https://github.com/lishilei123/SmartHub/actions/runs/33974681715/job/101329429134) 均为 `completed / success`。
- 该 CI 仅覆盖上述提交，不覆盖本次尚未提交的页面、测试与文档修改。历史本地测试结果见第 7 节，不能替代本次本地验证或当前提交 CI。
- 生产模型、生产 SSO、真实被测系统全流程及多 Worker 验证尚未进行，CI 通过不构成这些能力的验收。

## 本次语义修订

入口保留“系统设置 → 测试执行配置”，区域改为“AI 与 Runner 资源并发”，字段改为“AI 任务最大并发数”。已按 `runtime.ts` 和实际资源入口核实：AI 配额覆盖生成、受控探索、修复、失败诊断，需求分析、测试设计、评审与会话压缩，知识库 Embedding/Reranker 模型调用与配置测试，以及模型探测；不同 AI 操作可能互相等待。Runner 独立覆盖真实 Playwright 执行与受管认证准备。限制的是受管操作并发，不是模型服务商请求速率。

保留 Runner 默认 3（1～16）、AI 默认 1（1～8）。保存草稿不生效，发布后供调度器读取；页面展示已发布配置或兼容回退值，不代表所有 Worker 已确认应用。Worker 正常情况下约 5 秒轮询，Governor 在资源入口按需刷新，读取间隔至少 5 秒；读取失败保留最近有效值，调低不强制终止已运行任务。数据库明确发布配置优先，旧 `SMARTHUB_TEST_EXECUTION_CONCURRENCY` 只兼容 Runner；不提供新的 Runner/Agent 并发环境变量。

共享仅限当前进程，每个 Worker 拥有独立配额，多 Worker 总容量叠加；API 与 Worker 分进程时也不共享 Governor。集群全局配额与跨进程 Workspace 互斥尚未实现，同一 Workspace 应由一个 Worker 进程管理。详细配置与部署边界统一见 [README](../README.md#ai-与-runner-资源并发)。本次未修改调度、心跳停止语义、Service 状态机、数据库或历史 Hash/Snapshot。

## 本次语义修订的本地验证（2026-09-05）

在 `b3287cb960e2935bd1e7ea091b03b5f70f8152ee` 上应用本次未提交修改后执行：

| 验证 | 结果 |
| --- | --- |
| 配置 Service/API、真实 Chromium 页面、Governor、Scheduler、Worker 定向测试 | 30/30 通过，无跳过 |
| `npm test` | 443/443 通过，无失败、取消、跳过或 todo |
| `npm run build` | 前端与服务端通过；保留 Vite 大于 500 kB 的 chunk 提示 |
| `npm run format:check`、`git diff --check` | 通过 |

现有页面行为测试仅更新可访问名称和发布值展示断言；加载失败与恢复、非法值校验、保存草稿不提前生效、发布、保存失败保留数据、持久化重载断言全部保留。没有新增读取 TSX 源码匹配文案的测试，没有删除、跳过或放宽测试。

本次未重跑 `npm run test:postgres`：仅调整页面文案、既有行为测试和文档，没有数据库或调度变更；远端 PostgreSQL 结果仅对应上方提交。本次也未进行生产模型、SSO、真实被测系统完整流程、多 Worker 或页面人工视觉验收；真实 Chromium 页面行为验证不代表这些验收。未创建提交、未推送。

本次日志：`.tmp/resource-semantics-focused.log`、`.tmp/resource-semantics-npm-test.log`、`.tmp/resource-semantics-build.log`。

## 1. 历史代码基线

- 当时执行 `git fetch origin PI-Agent`，远端最新 HEAD 为 `18851665d467b1fac5f7f2520c05895f8621a307`。
- 当时本地 HEAD 为 `27fa7ee92463860c27302e03ca7e40ca97eaf54d`，是上述远端提交的后继，已有资源分流、配置草稿/发布及 Migration 45。该轮保留并增量补齐此实现。
- origin 配置为 `lishilei123/-SmartHub`；GitHub API 返回规范仓库链接 `lishilei123/SmartHub`。

## 2. 已确认的问题与 CI 证据

- 旧 Worker 把所有 Abort 都收口为 cancelled；心跳数据库异常、失租及关闭因此可能制造错误取消或业务失败。
- Service 在部分模型/Runner 返回及异步事务边界缺少停止检查，迟到输出可能继续发布。
- 现有调度器限制 Job 领取数量；同进程其他模型入口、认证准备及 Session 等候需要额外的实际资源治理。
- 前端用代码默认值初始化而未完全服从后端有效配置；旧执行并发环境变量被取消读取，缺少迁移兜底。
- 写队列的原始异常传播与失败后恢复已由基线修复，本轮补异常边界回归；回滚失败必须销毁连接。

当时通过 GitHub API 核对旧基线 `18851665d467b1fac5f7f2520c05895f8621a307` 的 [CI Run 33969896751](https://github.com/lishilei123/SmartHub/actions/runs/33969896751)：Run tests 失败，Build 与 PostgreSQL 集成均被跳过。原始日志下载返回 HTTP 403，未读取该次失败的完整浏览器日志。这是历史失败证据，当前 HEAD 的 CI 见本文开头。

## 3. LocalWorkspaceRunner 复现与修复

在匹配的 Playwright 1.58.2 / Chromium 1208 环境中，指定同源 localStorage 测试通过；将子进程浏览器缓存指向空目录后，同一真实测试失败，诊断为 `PLAYWRIGHT_EXIT_1`，退出码 `1`，failure event 包含 `browserType.launch: Executable doesn't exist`。这证明缺少浏览器安装能真实复现该失败模式，且现有 CI 确实缺少安装步骤；远端原始失败是否还有其他原因仍受日志权限限制。

CI 新增 `npx playwright install --with-deps chromium`。测试和 Build 独立 Job 执行；PostgreSQL Job 依赖两者通过，无重复全量测试。

Runner 测试失败输出 error、summary、关键 events、exitCode 和 Playwright 版本。保留并加强 API 200、真实 UI 通过、localStorage 驱动 DOM、API Cookie 不进入 UI Context、页面请求不注入 API Authorization 等断言；检查临时执行目录与端口清理。修复 Runner spawn 前与 Abort listener 注册间的竞态，清理 timeout/listener 并监听子进程 error。

## 4. 停止原因与正式状态

| 原因 | 处理 |
| --- | --- |
| `user_cancelled` | 来自数据库明确取消请求；按已有状态机取消，不再创建 Revision/Binding。 |
| `lease_lost` | 中止当前工作；不使用旧 Token 完成或发布，不写业务失败，由租约接管恢复。 |
| `heartbeat_unavailable` | 中止昂贵调用；能够带有效 Token 安全释放时按现有退避重排，否则不继续写入，等待过期恢复。 |
| `worker_shutdown` | 中止执行及等待；安全释放或等待恢复，不归为取消或业务失败。 |

结构化续租兼容原 boolean 接口。心跳保留单个 inFlight，并在退出时等待 Promise 收口。明确取消与旧 Token 按 owner、runToken、Fencing Token、实时租约及取消标记区分。

执行 Service 的租约事务在进入、每个正式写操作前后和回调结束时复查停止信号。Workspace 发布在已有文件锁内重新检查租约；PostgresStore 在持久化完成后、COMMIT 前复查实时租约。SyncTask 同时承载租约和业务状态，因此允许同一有效 Token 的 Service 写入 succeeded/failed/superseded-cancelled，仍拒绝失租和明确取消标记；不会把 superseded 伪装成用户取消请求。

已有运行中 Attempt 或耗尽预算时释放可能被状态机拒绝，此时保留现场，使用现有租约协调机制及基础设施重试预算。

## 5. Runner/Agent 分流

- 独立预检通道校验 Binding、Case 内容、入口、Hash、依赖闭包及环境；不占 Agent 配额。
- 成熟脚本直接进入 Runner；受管认证准备浏览器也申请 Runner 配额。
- 生成、受控探索、修复、FailureAnalysis 及 Pi execute/review/compact 统一使用 Agent 配额。
- 同进程知识库 Embedding/Reranker、模型探测亦接入共享 Agent 配额。
- Agent 生成后先释放配额，再领取 Runner；Runner 失败后先释放 Runner，再进入 Agent 诊断/修复。保留既有 Task 阶段交接、尝试次数、退避和 Repair 预算。
- 进程共享 Governor 限制实际调用；两类等候队列独立、各最多 128 项，支持 Abort，结束后归还配额。Pi Session 队列也支持 Abort，取消中间等待者不会提前释放前序锁。

## 6. 配置及兼容

- 后端默认 Runner **3**，范围 **1–16**；Agent **1**，范围 **1–8**。Runner 延续原分支默认执行并发 3，Agent 使用保守默认 1。
- 当时入口：系统设置 → 测试执行配置 → 并发控制（现改名“AI 与 Runner 资源并发”）。保存草稿后发布才供调度器读取；历史配置不可变。
- Worker 每 5 秒读取；实际资源入口也最多每 5 秒刷新，读取失败保留最近有效值。调低不打断已有配额，新申请按新上限授予。
- 优先级：数据库明确发布配置 → 旧 `SMARTHUB_TEST_EXECUTION_CONCURRENCY` → 后端默认。旧变量合法范围 1–8，仅映射 Runner；无效值回默认，Agent 默认 1。
- 未增加新的必填并发环境变量。本轮复用既有 Migration 45，不新增迁移或不可逆删除。
- 页面从后端有效值加载，保存失败保留配置并显示真实错误；保存旧客户端省略字段时保留现有效值。

## 7. 历史本地验证覆盖与结果

- `npm test`：443/443，通过，无 skipped/todo。包含真实 Chromium Runner、真实配置页面、Worker 心跳、Service、资源配额与 Store 异常边界。
- `npm run build`：通过，含前端 TypeScript/Vite 及服务端构建。保留现有大于 500 kB 的 Vite chunk 提示。
- `npm run test:postgres`：21/21，通过，无跳过。使用本地独立 PostgreSQL 18.4、端口 55439、全新 `smarthub_worker_revision_complete_test`，实际迁移并验证；未使用生产库。
- `npm run format:check` 与 `git diff --check`：通过。
- 真实 Runner 定向测试 8/8；Postgres 写队列异常测试 8/8；资源 Governor 7/7；Session 行为测试 5/5；配置 Service/API/真实页面定向测试 9/9。
- 回归覆盖原始异常、后续排队恢复、回滚失败销毁连接、四种停止原因、心跳 drain、迟到候选/PASS、事务中途 Abort、两类队列互不阻塞、动态配额、有界等待、permit 归零、Session 取消和配置持久化。
- PostgreSQL 覆盖阶段分流、交接、旧 Token、实时租约过期回滚、运行 Attempt 取消、配置跨连接发布、SyncTask 三种合法终态和过期回滚。

验证日志保留于 `.tmp/worker-revision-npm-test-complete.log`、`.tmp/worker-revision-build-complete.log`、`.tmp/worker-revision-postgres-complete.log`、`.tmp/worker-revision-format.log`。

## 8. 验证边界

- 当时尚未推送，修订后的 GitHub Actions 尚未运行；此结论已被本文开头的当前 HEAD 查询更新。Linux CI 使用 pgvector/PostgreSQL 16；当时本地实际验证为 PostgreSQL 18.4。
- 并发是单进程限制，不是集群全局配额；多 Worker 配额叠加，数据库令牌及跨进程 Workspace 文件锁仍为后续工作。
- 未执行真实外部生成模型、生产 SSO、生产被测系统全流程或多 Worker 压力验收。模型/并发替身只用于状态与异常测试，真实浏览器与数据库测试另行执行。
- 本地模型原生推理没有强制中断 API；已开始的单次推理保留配额直至返回，停止信号阻止后续批次和正式发布。
- Workspace 文件和 PostgreSQL 不构成跨介质原子事务；本轮增加租约与锁内检查，未声称实现分布式事务。
- 未放宽业务断言、未删除/跳过失败测试、未用模拟结果冒充真实 Playwright、未绕过 Service 写正式业务状态、未新增质量指标、未接入 Playwright Generator。

## 9. 修改文件

CI、文档和配置入口：`.github/workflows/ci.yml`、`.env.example`、`README.md`、本文件、`src/app/TestExecutionSettings.tsx`。

运行时与服务：

- `server/worker.ts`
- `server/runtime.ts`
- `server/agent/pi-agent-runtime.ts`
- `server/agent/pi-session-runtime.ts`
- `server/application/execution-resource-governor.ts`（新增）
- `server/application/knowledge-service.ts`
- `server/application/model-service.ts`
- `server/application/requirement-analysis-service.ts`
- `server/application/test-design-service.ts`
- `server/application/test-execution-service.ts`
- `server/application/test-execution-infrastructure-configuration-service.ts`
- `server/domain/worker-stop.ts`（新增）
- `server/domain/test-execution-infrastructure-configuration.ts`
- `server/infrastructure/store.ts`
- `server/infrastructure/postgres-store.ts`
- `server/infrastructure/test-execution-store.ts`
- `server/infrastructure/execution-workspace-store.ts`
- `server/runner/local-workspace-runner.ts`

测试：

- `tests/execution-resource-governor.test.ts`（新增）
- `tests/postgres-write-queue.test.ts`（新增）
- `tests/test-execution-settings-browser.test.ts`（新增）
- `tests/local-workspace-runner.test.ts`
- `tests/pi-session-runtime.test.ts`
- `tests/requirement-analysis-agent.test.ts`
- `tests/test-design-requirements-package.test.ts`
- `tests/test-execution-infrastructure-configuration.test.ts`
- `tests/test-execution-service.test.ts`
- `tests/test-execution-worker.test.ts`
- `tests/review-job-postgres.integration.ts`
- `tests/test-execution-postgres.integration.ts`
