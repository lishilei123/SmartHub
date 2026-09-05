# 测试执行并发优化验收记录

基线：`PI-Agent`，`1885166`；已 fetch 并核对与 `origin/PI-Agent` 一致。本次仅提交本地代码，不推送远端。

## 实现结果

1. Runner / Agent 使用独立容量；共享持久化 Job 表按 Task 状态定向领取，并非两张独立队列表。
2. 独立单槽预检只检查 Binding、Case 内容、入口、依赖与 Workspace，不运行 Playwright 或调用 Agent。成熟脚本进入 Runner，缺失/失效 Binding 进入 Agent 生成或探索；候选经 Validator 后重新进入 Runner。
3. Runner 默认 3，范围 1～16；Agent 默认 1，范围 1～8。统一领域模块管理默认值与校验。不使用并发环境变量；删除旧测试执行并发变量示例，保留其余工作流配置。
4. 页面入口：系统设置 → 测试执行配置 → 并发控制。展示当前值、来源、草稿、发布版本、发布时间和发布人；支持保存草稿、发布和重新读取。
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

## 验证结果

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
- 浏览器连接列表为空，未完成真实页面点击及视觉验收；页面 API 序列化、真实 HTTP、Service 与 PostgreSQL 均已验证。
- 未重新进行真实模型生成/修复、生产浏览器/SSO、目标产品完整执行和多 Worker 负载验收。单元测试中的 Runner/Agent 测试替身只用于验证治理行为，未冒充产品执行结果。
- 正式 Generator 接入留待公开接口与运行方式匹配；本轮没有新增完整 Generator 能力。
- 测试 API、Worker、隔离 PostgreSQL 已停止。自动审批拒绝删除 .tmp/pg-resource-handoff-20260905，仅返回 blocked by policy；临时目录及测试摘要保留。

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
