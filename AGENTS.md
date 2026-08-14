# SmartHub Agent Guide

## 项目

SmartHub 是基于 Pi Agent 的 AI 自动化测试平台。

核心流程：

```text
需求分析
→ 测试设计
→ 测试执行
→ 测试报告
```

生产数据使用 PostgreSQL，通过 `ProjectVersion` 管理版本。

---

## 修改原则

修改代码前先理解现有实现。

优先阅读与任务相关的：

```text
Domain
Service
Route
Store
Frontend
Tests
```

基于现有架构增量修改。

不要为了单个需求大规模重构，也不要重复建设已有能力。

---

## 架构原则

```text
Agent    → 理解、推理、生成
Skill    → 提供专业能力
Workflow → 编排流程
Service  → 管理业务状态
Runner   → 真实执行
Database → 保存正式事实
```

Agent 不负责正式状态、版本和数据库事实。

确定性的业务规则优先由代码实现。

Agent 架构根据任务复杂度选择：

```text
Single Agent + Skills
或
Multi-Agent Workflow
```

不要为了多 Agent 而多 Agent。

---

## 数据与测试原则

正式数据必须可追溯，历史版本不得覆盖。

正式运行使用固定版本或 Snapshot，不动态依赖 `latest/current`。

Agent 不得猜测缺失的业务事实。

信息不足时标记：

```text
needs_confirmation
blocked
```

真实测试必须由 Runner 执行。

禁止伪造测试结果、日志、截图。

禁止为了 PASS 修改：

```text
Expected Result
业务断言
Requirement
TestCase 业务语义
```

---

## 开发要求

优先复用现有基础设施。

功能未实现时明确标记未实现，不要用模拟数据冒充真实能力。

修改完成后执行相关构建，不编写测试代码，只删除不符合当前的测试代码，并说明：

```text
修改内容
未完成项
```

---

## 核心原则

```text
Agent 负责智能。
Workflow 负责流程。
Service 负责治理。
Runner 负责执行。
PostgreSQL 保存事实。

不伪造。
不猜测。
不覆盖历史版本。
不为了 PASS 修改业务事实。
默认不新增测试代码，只删除不符合当前修改的测试代码。
```
