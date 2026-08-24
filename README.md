# SmartHub

SmartHub 是基于 Pi Agent 的 AI 自动化测试平台。当前测试执行只保留 Agent Test 主链，不提供 UI/API 脚本执行兼容层。

## 当前主链

1. PlanningAgent 读取 ProjectVersion、Requirement Release、Workspace 与 Knowledge，生成 TestCase v3 Candidate。
2. Test Design Service 校验并发布不可变正式用例库；每条可执行 Case 固定使用 `executionMethods: [agent]` 并包含完整 `agentTestSpec`。
3. 创建 Execution Run 时，Service 冻结 Handoff、正式 Case、Agent Under Test 版本、AgentRunner 与 FailureAnalysis 配置。
4. AgentRunner 通过冻结的 HTTP 或 SSE 契约真实调用被测 Agent，按 Repeat 保存 Trace、Assertion、Evaluation、延迟、Token 与成本事实。
5. 确定性规则先给出结果；只有语义或安全标准需要模型判断。失败分析 Agent 只基于已保存证据生成 Root Cause Candidate。
6. 报告 Service 从 PostgreSQL 正式事实生成 `agent-test-execution-report/v1` canonical JSON 与 Markdown。

旧的浏览器脚本生成、脚本修复、执行环境配置、脚本 Revision、脚本 Attempt、执行 Artifact、维护建议及相应 API/UI 已删除。Migration 39 会删除对应历史执行数据和表，Migration 40 会清理旧执行 Agent、Skill 与 Browser Tool 配置，不提供读取兼容。

## 正式事实边界

- Agent 负责理解、推理与候选生成。
- Service 负责 ID、状态迁移、版本、Hash、冻结快照和审计边界。
- Validator 负责确定性协议与业务约束。
- AgentRunner 负责真实调用被测 Agent 并采集结构化证据。
- PostgreSQL、ProjectVersion、Snapshot 与 Release 是正式事实来源。
- 已发布 Requirement Release、正式 Test Case Revision、Library 与 Run 输入不可变。
- 凭据只通过服务端环境变量解析，不写入 Case、Run Snapshot、Trace 或报告。

## Agent Test Case

`agentTestSpec` 描述：

- 输入与上下文；
- 期望业务结果；
- 必须/禁止的 Tool 与 Action；
- 参数、顺序、业务结果与 Artifact 断言；
- 语义与安全标准；
- Timeout、最大步骤、Repeat 和可选成本上限。

看不到某类 Trace 只表示该证据域为 `partial` 或 `unavailable`，不能推断动作没有发生。

## 本地运行

要求 Node.js、npm 与 PostgreSQL。复制 `.env.example` 为 `.env.local`，配置正式数据库与模型连接后执行：

```powershell
$ErrorActionPreference = 'Stop'
npm install
npm run migrate
npm run dev
```

Worker 单独运行：

```powershell
$ErrorActionPreference = 'Stop'
npm run worker
```

## 验证

```powershell
$ErrorActionPreference = 'Stop'
npm run build
npm test
```

PostgreSQL 集成测试必须使用名称包含 `test` 的隔离数据库：

```powershell
$ErrorActionPreference = 'Stop'
$env:TEST_DATABASE_URL = 'postgresql://.../smarthub_test'
npm run test:postgres
```

不要将生产数据库用于测试或清理命令。构建通过不代表真实 PostgreSQL、浏览器或模型 E2E 已验证。
