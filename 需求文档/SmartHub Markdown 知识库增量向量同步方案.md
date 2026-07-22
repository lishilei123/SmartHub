# SmartHub Markdown 知识库增量向量同步方案

## 1. 文档定位

本文说明 Phase 1 当前采用的 Markdown/TXT 上传、持久化异步任务、增量向量化和候选索引发布方案。需求基线以[第一期需求文档](第一期-项目知识库构建与配置需求文档.md)为准。

Phase 1 仅支持网页/API 文件上传，不实现本地目录监听、文件系统扫描或来源对账。未来 Wiki、文档平台等来源通过 Source Connector 接入，并复用本文定义的快照、任务、资产版本、候选索引和证据契约。

## 2. 设计目标

1. 上传请求快速返回持久化任务，不在 HTTP 请求中执行模型推理。
2. 相同资产、相同内容 Hash 不重复创建版本、任务、Embedding 或索引。
3. 局部内容变化只向量化新增或变化的 Chunk。
4. 新结果只在候选完整、任务仍有效且配置兼容时切换为活动索引。
5. 失败、取消、进程中断和陈旧任务不得破坏旧活动索引。
6. 检索结果绑定固定资产版本、Chunk、标题路径和原文位置。

## 3. 总体流程

```text
网页/API 上传 Markdown/TXT
  → 校验扩展名、逻辑路径、大小和文本内容
  → 固化不可变原文快照
  → 内容 Hash 去重
  → 创建 AssetVersion(pending) 与 SyncJob(queued)
  → 返回 202 Accepted + jobId

Worker 领取任务
  → 标记 running，创建 IndexVersion(candidate)
  → 读取固定原文快照
  → AST/文本切分
  → 匹配稳定 chunkKey 与内容 Hash
  → 复用未变化且维度兼容的向量
  → 批量生成变化向量
  → 组装候选索引固定成员和 IndexChunk 快照
  → 校验任务、取消状态、配置、成员和向量维度
  → 条件事务切换 activeIndexVersionId
  → AssetVersion/SyncJob 变为 ready/succeeded
```

## 4. 关键对象

| 对象 | 关键字段 | 约束 |
|---|---|---|
| `KnowledgeAsset` | `assetId`、逻辑路径、资料类型、活动版本 | 同一逻辑资料保持稳定 ID。 |
| `AssetVersion` | `assetVersionId`、内容 Hash、原文快照、状态、配置版本 | 内容和首次生成的 Chunk 在 `ready` 后不可原地修改。 |
| `SyncJob` | 类型、状态、步骤、进度、尝试数、输入版本、配置版本、候选索引 | 先持久化再执行；恢复和重试保持幂等。 |
| `IndexVersion` | `candidate/active/superseded/failed`、成员范围、配置版本 | 未通过校验前不得参与默认检索。 |
| `IndexChunk` | 索引版本、资产版本、Chunk、向量 | 保存该索引实际使用的固定 Chunk 快照；重建不得改写资产版本 Chunk。 |

## 5. 上传与去重

- `sourceType` 在 Phase 1 固定为 `upload`。
- 客户端只提交逻辑路径，不得指定服务器物理存储路径。
- 同一知识库、同一逻辑路径定位同一资产；默认冲突策略为 `new_version`。
- 当前活动版本 `contentHash` 与上传内容一致时，返回已有成功结果，不创建任务。
- 新内容先保存版本快照并创建 `queued` 任务，上传接口不等待 Embedding 完成。

未来 Source Connector 应提交稳定外部 ID、逻辑路径、内容 Hash 和不可变快照引用，不得直接写 Chunk、Embedding 或活动索引。

## 6. 稳定切分与增量向量

Markdown 使用 AST 结构作为切分边界，保留标题、段落、列表、代码块、表格和原文定位；TXT 使用段落或行区间。每个 Chunk 至少记录：

- `chunkKey`、内容 Hash、序号；
- 完整 `headingPath`；
- 起止行号和字符范围；
- Token 数、Embedding 和维度；
- 所属固定 `assetVersionId`。

匹配上一个成功版本时，标题路径和内容 Hash 一致的 Chunk 复用稳定 `chunkKey` 与向量；维度不一致或解析/切分/模型兼容配置变化时不得复用。

## 7. 候选索引与条件切换

Worker 开始执行时创建 `candidate` 索引。Embedding 完成后，提交事务必须重新确认：

1. 任务仍为 `running`，没有被取消；
2. 候选索引仍属于当前任务和知识库；
3. 配置版本与任务快照一致；
4. 同一资产没有更高版本任务取代当前版本；
5. 候选成员、Chunk 与向量维度完整兼容；
6. 重建任务启动后活动索引没有被其他任务替换。

满足条件后才执行：

```text
candidate → active
previous active → superseded
KnowledgeBase.activeIndexVersionId → candidate.id
AssetVersion → ready
SyncJob → succeeded
```

任何校验失败、取消或异常只把候选标记为 `failed`，旧活动索引保持不变。

## 8. 中断恢复与重试

- 服务启动时查找 `queued/running` 任务；中断的 `running` 任务重新置为 `queued`。
- 中断任务关联的未提交候选索引标记为 `failed`，恢复时创建新候选。
- 重试复用失败资产版本和固定原文快照，提高 `attempts`，不重复创建资产版本。
- Worker 恢复提交前仍执行完整条件校验，防止陈旧任务覆盖新索引。

## 9. PostgreSQL 持久化

PostgreSQL 是事务真相来源：

- 每次写事务先获取数据库事务锁，并在锁内读取最新状态；
- 仅对发生变化的实体执行 `INSERT ... ON CONFLICT DO UPDATE` 或定向删除；
- 禁止使用全库 `TRUNCATE + 全量重写` 作为业务写路径；
- 资产 Chunk 与索引固定 Chunk 分表保存，避免索引重建改写不可变资产版本；
- pgvector 用于向量召回，pg_trgm 用于关键词召回。

JSON Store 仅作为未配置 PostgreSQL 时的单机开发回退，不作为多实例生产存储。

## 10. 检索降级

- 关键词模式不依赖 Embedding Provider。
- 混合模式的查询向量生成失败时，降级为关键词检索，并在响应中返回 `degraded` 和原因。
- 纯向量模式不可用时返回 `vector_unavailable`，不得伪装为无匹配结果。
- Reranker 失败时保留一阶段召回排序，并标记 Reranker 降级。
- 首次索引处理中、无活动索引、筛选排空和正常无匹配使用不同业务状态。

## 11. 验证重点

1. 上传返回 `queued` 时活动索引不变化，Worker 成功后才激活候选。
2. Embedding 进行中取消任务，旧活动索引保持不变。
3. 重建使用新的 `IndexChunk`，资产版本原 Chunk 不被改写。
4. 进程重启后任务可恢复，废弃候选不会成为活动索引。
5. 相同内容重复上传不创建版本、任务或索引。
6. 局部修改复用未变化 Chunk 的向量。
7. 向量服务故障时混合检索退回关键词，纯向量返回明确不可用状态。
