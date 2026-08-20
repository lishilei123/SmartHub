# SmartHub Agent Guide

## 项目

SmartHub 是基于 Pi Agent 的 AI 自动化测试平台。

---

## 修改原则

修改前先理解现有实现，基于现有架构增量修改。

优先复用：

* Runtime
* Service
* Validator
* Workspace
* Version / Snapshot
* Tool Governance

不要：

* 大规模重构
* 重复已有能力
* 绕过 Service
* 绕过版本机制
* 使用模拟数据冒充真实能力

---

## 架构边界

Agent → 理解、推理、生成候选

SubAgent → 独立分析、Review、上下文隔离

Skill → 专业能力

Workflow → 流程控制

Service → 正式业务状态

Validator → 确定性规则

Runner → 真实测试执行

PostgreSQL → 正式事实

确定性业务规则优先由代码实现。

---

## 多 Agent / SubAgent 与模型分配

根据任务复杂度决定是否使用 SubAgent / Multi-Agent，不为拆分而拆分。

优先单 Agent 完成简单任务；当任务存在以下情况时，可拆分 SubAgent：

* 上下文较大，需要隔离处理
* 存在多个相对独立的分析任务
* 需要独立 Review / Audit
* 任务复杂度较高，单 Agent 容易丢失上下文
* 可并行执行且合并结果风险可控

模型根据任务难度动态分配：

* 简单读取、检索、格式转换、确定性操作 → 快速/低成本模型
* 常规分析、代码修改、测试设计 → 默认模型
* 复杂推理、架构设计、疑难问题、关键 Review → 高能力模型

不同 SubAgent 可以使用不同模型。

模型选择由任务复杂度、上下文规模、风险和推理需求决定，不固定绑定某个 Agent。

当低级模型无法可靠完成任务时，允许升级到更高能力模型重新处理。

---

## 核心原则

Agent 负责智能，Service 负责治理。

Context 可以压缩，正式事实必须从：

PostgreSQL / Version / Snapshot / Release

重新读取。

禁止：

* 伪造结果
* 信息不足时猜测
* 覆盖正式历史版本
* 为了 PASS 修改业务事实

---

## 开发要求

未实现的能力明确标记未实现。

默认不新增测试代码，可删除或调整已不符合当前架构的旧测试。

修改完成后至少执行：

```bash
npm run build
```

并修复本次修改造成的构建错误。
