# 测试执行并发优化验收记录

历史基线：`PI-Agent`，`1885166`；当时已 fetch 并核对与 `origin/PI-Agent` 一致。原“仅提交本地代码、不推送远端”为当时计划，不是当前仓库状态。下文实现、Migration 45、本地结果和文件列表保留当时事实；现行配置语义以 [README](../README.md#ai-与-runner-资源并发) 为准。

## 当前 HEAD 的远端 CI

2026-09-05 23:48（UTC+08:00）通过 GitHub Actions API 按完整提交 SHA 查询：本地与远端最新 `PI-Agent` 均为 `b3287cb960e2935bd1e7ea091b03b5f70f8152ee`，[CI Run 33974681715](https://github.com/lishilei123/SmartHub/actions/runs/33974681715)（`push`）为 `completed / success`；tests、build、postgres-integration 三个 Job 均为 `completed / success`。查询与 Job 链接见 [Worker 验证记录](worker-concurrency-fix-verification.md)。该结果仅覆盖该提交，不覆盖本次未提交的语义修订，也不替代以下历史本地结果。生产模型、SSO、真实被测系统全流程及多 Worker 验证尚未进行。

## 后续修订后的现行语义

本次未提交语义修订的本地验证：定向测试 30/30、`npm test` 443/443、`npm run build`、`npm run format:check`、`git diff --check` 均通过，测试无跳过；构建保留 Vite chunk 大小提示。因无数据库或调度变更，本次未重跑 PostgreSQL 集成，也未进行生产模型、SSO、真实被测系统全流程、多 Worker 或人工视觉验收。详细记录见 [本次本地验证](worker-concurrency-fix-verification.md#本次语义修订的本地验证2026-09-05)。

- 页面区域已改为“AI 与 Runner 资源并发”，字段为“AI 任务最大并发数”，保留既有测试执行配置入口及内部 `agentConcurrency`、API、数据库兼容。
- AI 配额由同进程的生成、探索、修复、失败诊断、需求分析、测试设计、评审/会话压缩、知识库 Embedding/Reranker 模型调用与配置测试、模型探测共享，任务类型间可能互相等待；Runner 独立限制真实 Playwright 执行及受管认证准备。受管操作并发不等于服务商请求速率限制。
- Runner 默认 3（1～16），AI 默认 1（1～8）；草稿保存不生效，发布后供调度器读取。Worker 正常约 5 秒轮询；Governor 在资源入口按需读取，间隔至少 5 秒。读取失败保留最近有效值，调低不强制终止运行任务。页面展示已发布配置或兼容回退值，不是所有 Worker 的应用确认。
- 数据库明确发布配置优先；后续修复已恢复旧 `SMARTHUB_TEST_EXECUTION_CONCURRENCY` 仅映射 Runner 的兼容兜底。没有新增 `SMARTHUB_RUNNER_CONCURRENCY` 或 `SMARTHUB_AGENT_CONCURRENCY`。
- 每个 Worker 进程拥有独立配额，总容量叠加；API 与 Worker 分进程时不共享 Governor。集群全局配额及跨进程 Workspace 互斥仍为后续工作，同一 Workspace 应由一个 Worker 进程管理。本次语义修订没有数据库或调度逻辑变更，不新增迁移。

## 实现结果

1. Runner / Agent 使用独立容量；共享持久化 Job 表按 Task 状态定向领取，并非两张独立队列表。
2. 独立单槽预检只检查 Binding、Case 内容、入口、依赖与 Workspace，不运行 Playwright 或调用 Agent。成熟脚本进入 Runner，缺失/失效 Binding 进入 Agent 生成或探索；候选经 Validator 后重新进入 Runner。
3. Runner 默认 3，范围 1～16；Agent 默认 1，范围 1～8。统一领域模块管理默认值与校验。当时取消了旧并发环境变量，后续已恢复仅映射 Runner 的兼容兜底，现行规则见上文。
4. 当时页面入口：系统设置 → 测试执行配置 → 并发控制（现改名“AI 与 Runner 资源并发”）。展示配置值、来源、草稿、发布版本、发布时间和发布人；支持保存草稿、发布和重新读取。
5. Worker 启动读取 PostgreSQL 已发布配置，5 秒轮询；读取失败保留最后有效值。容量预留在数据库领取之前；阶段交接先归还租约，不等待另一资源槽位。
6. 调低容量不取消当前任务；运行数量低于新上限后再领取。调高容量无需重启即可新增任务。
7. 保留 Fencing Token、心跳、取消、最大尝试次数、退避和 Repair 预算。正常阶段交接退还本次领取次数，真实异常仍消耗原有预算。停止期间刚完成领取的任务也接收停止信号。
8. 明确网络不可达、受管认证/配置错误、数据未就绪由 Service 确定性分类；结构化 Reporter failure 证据参与判断。裸 401/403、普通超时、断言文本不被强行归因。
9. FailureAnalysisAgent 仅提交诊断候选及建议；Service 管理类别裁决、最终状态和修复预算。Agent 不能将失败改通过、更新 Binding、覆盖 Revision或弱化受保护断言。修复保留旧 Revision，重新校验并真实执行。
10. 生成/修复在租约保护内保存候选，Binding 为 needs_validation；真实 PASS 后在 Workspace 锁内检查入口和依赖 Hash 才升级，旧 PASS 不覆盖新 Binding。
11. Playwright / @playwright/test 1.58.2，@playwright/cli 0.1.18。官方 codegen 是交互式录制，Test Agents 是 Agent/工具工作流；未发现适合当前 CLI-first 服务端稳定嵌入的公开 Generator SDK，因此未接入完整 Generator，无内部 API、空 Adapter或不可用按钮。
12. 继续复用已经接入的官方 CLI snapshot、generate-locator、点击、填写和截图。本轮加强 Locator 顺序：getByRole、getByLabel、getByPlaceholder、getByTestId、稳定文本、稳定 CSS、XPath。CLI 不可用时失败，不编造候选。

官方资料：[codegen](https://playwright.dev/docs/codegen)、[Test Agents](https://playwright.dev/docs/test-agents)、[Playwright CLI](https://github.com/microsoft/playwright-cli)。

## Migration 45

- 添加按 Task 状态、排队 Job 领取的索引。
- Job 写入约束允许有效租约下的安全阶段交接退还一次领取计数；其他计数/取消/运行中 Attempt 保护保留。
- 新增 test_execution_infrastructure_configuration_drafts 草稿表。
- 新增配置并发数整数及范围约束；历史版本缺字段合法，读取时使用代码默认值，不改写历史内容与 Hash。
- 已在隔离 PostgreSQL 18 验证迁移。未对当前正式数据库执行迁移；部署本次代码前需执行 npm run migrate，并在没有运行中任务时更新 Worker 代码。

## 历史本地验证结果

| 验证 | 结果 |
| --- | --- |
| npm test | 413/413 通过，无跳过 |
| npm run test:postgres | 全新隔离 PostgreSQL 18 数据库 19/19 通过 |
| npm run build | 前端、服务端构建通过；Vite 保留主包大于 500 kB 的提示 |
| git diff --check | 通过 |
| 真实 HTTP → Service → PostgreSQL | 默认 3/1；草稿 5/2 不提前生效；发布后重新读取 5/2，通过 |
| 真实独立 Worker | 启动读取 5/2；发布后同进程动态读取 2/1，无重启，通过 |
| 行为测试 | 动态升降、读取失败保留容量、资源隔离、独立预检、成熟/失效 Binding、交接计数与 fencing、两类任务取消、旧 PASS 防覆盖、诊断越权拒绝、Generator/CLI 不可用行为通过 |

## 当前限制和未验证部分

- 并发容量为单 Worker 进程容量；跨 Worker 全局配额及 Workspace 跨进程文件锁尚未实现，同一 Workspace 应由一个 Worker 进程管理。
- 文件系统与 PostgreSQL 尚未形成跨介质原子事务；候选文件仍需校验及真实 Runner PASS 才能升级 Binding。
- 当时浏览器连接列表为空，未完成真实页面点击及视觉验收；页面 API 序列化、真实 HTTP、Service 与 PostgreSQL 均已验证。后续已加入真实 Chromium 页面行为测试，历史结果见 [Worker 验证记录](worker-concurrency-fix-verification.md#7-历史本地验证覆盖与结果)，不能用当时浏览器不可用概括当前覆盖。
- 未重新进行真实模型生成/修复、生产浏览器/SSO、目标产品完整执行和多 Worker 负载验收。单元测试中的 Runner/Agent 测试替身只用于验证治理行为，未冒充产品执行结果。
- 正式 Generator 接入留待公开接口与运行方式匹配；本轮没有新增完整 Generator 能力。

## 修改文件列表

- `.env.example`
- `README.md`
- `server/agent/agents-config.json`
- `server/agent/pi-test-execution-runtime.ts`
- `server/application/ai-resource-service.ts`
- `server/application/execution-resource-scheduler.ts`
- `server/application/test-execution-infrastructure-configuration-service.ts`
- `server/application/test-execution-service.ts`
- `server/application/test-execution-validation.ts`
- `server/domain/test-execution-infrastructure-configuration.ts`
- `server/domain/test-execution-types.ts`
- `server/domain/types.ts`
- `server/http/server.ts`
- `server/infrastructure/execution-workspace-store.ts`
- `server/infrastructure/migrations.ts`
- `server/infrastructure/postgres-store.ts`
- `server/infrastructure/store.ts`
- `server/infrastructure/test-execution-store.ts`
- `server/skills/failure-analysis/SKILL.md`
- `server/skills/script-repair/SKILL.md`
- `server/skills/test-script-generation/SKILL.md`
- `server/worker.ts`
- `src/app/SystemSettings.tsx`
- `src/app/TestExecutionSettings.tsx`
- `src/test-execution-infrastructure-api.ts`
- `tests/execution-resource-scheduler.test.ts`
- `tests/execution-workspace-store.test.ts`
- `tests/playwright-browser-tools.test.ts`
- `tests/test-execution-foundation.test.ts`
- `tests/test-execution-infrastructure-configuration.test.ts`
- `tests/test-execution-postgres.integration.ts`
- `tests/test-execution-service.test.ts`
- `tests/test-execution-worker.test.ts`
- `docs/test-execution-concurrency-verification.md`（本记录）
