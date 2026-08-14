# SmartHub Agent Guide

## 项目

SmartHub 是基于 Pi Agent 的 AI 自动化测试平台。

---

## 修改原则

修改前先理解现有实现，基于现有架构增量修改。

优先复用：

- Runtime
- Service
- Validator
- Workspace
- Version / Snapshot
- Tool Governance

不要：

- 大规模重构
- 重复已有能力
- 绕过 Service
- 绕过版本机制
- 使用模拟数据冒充真实能力

---

## 架构边界

Agent      → 理解、推理、生成候选
SubAgent   → 独立分析、Review、上下文隔离
Skill      → 专业能力
Workflow   → 流程控制
Service    → 正式业务状态
Validator  → 确定性规则
Runner     → 真实测试执行
PostgreSQL → 正式事实

确定性业务规则优先由代码实现。

---

## 核心原则

Agent 负责智能，Service 负责治理。

Context 可以压缩，正式事实必须从
PostgreSQL / Version / Snapshot / Release 重新读取。

禁止：

- 伪造结果
- 信息不足时猜测
- 覆盖正式历史版本
- 为了 PASS 修改业务事实

---

## 开发要求

未实现的能力明确标记未实现。

默认不新增测试代码，可删除或调整已不符合当前架构的旧测试。

修改完成后至少执行：

npm run build

并修复本次修改造成的构建错误。