# SmartHub Markdown 知识库增量向量同步方案

> 配套业务方案：需要上传需求文档、检索本知识库并生成设计方案时，参见《需求文档上传与知识库检索分析设计方案》；未经确认的需求分析内容默认不进入正式知识库。

## 1. 目标与结论

目标是把项目内 Markdown 文档持续同步为可检索的知识库，并保证：

- 保存后自动同步，通常在数秒内可检索；
- 同一文件反复修改不会产生重复数据；
- 只为新增或内容变化的 Chunk 调用 Embedding；
- 同步失败时继续使用上一成功版本，不让线上知识库出现短暂空窗；
- 正确处理新增、修改、删除、重命名、连续保存和服务重启；
- 可追踪每个文件的同步状态、错误原因、Token 用量和模型版本；
- 后续可扩展到多项目、多租户、权限过滤和混合检索。

推荐的第一阶段技术栈：

| 模块 | 选型 | 原因 |
|---|---|---|
| 应用 | Node.js 22 + TypeScript | 与 Chokidar、Markdown 解析生态结合简单 |
| 文件监听 | Chokidar | 统一处理 add/change/unlink 和编辑器原子写入 |
| 文件上传 | HTTP API + 对象存储/受控目录 | 支持网页上传、覆盖更新和批量导入 |
| Markdown 解析 | unified + remark-parse + mdast-util-to-string | 基于 AST，避免用正则或字数硬切 |
| 主数据库 | PostgreSQL 16+ | 同时管理文档、任务、版本和事务 |
| 向量扩展 | pgvector 0.8+ | 早期无需维护独立向量数据库，支持精确检索和 HNSW |
| 队列 | PostgreSQL Job 表 | 单机和中小规模足够可靠；规模扩大后替换为 Redis/BullMQ |
| Embedding | 可插拔 Provider | 云端可用 `text-embedding-3-small`，本地可用 BGE-M3 |

不建议第一版就引入 Qdrant/Milvus + PostgreSQL 两套存储。只有当向量达到千万级、需要独立扩缩容或高级向量检索能力时，再迁移专用向量数据库。

## 2. 总体架构

```text
本地 Markdown 目录 ── File Watcher ──┐
                                    ├──> sync_jobs（持久化队列）
网页/API 上传 ───── Upload API ──────┘             │
                                                   ▼
                                            Sync Worker
                         ┌────────────┼────────────┐
                         │            │            │
                      读取文件     AST 结构切分   Hash/Diff
                                                   │
                                    仅新增/变化 Chunk Embedding
                                                   │
                                                   ▼
                                      PostgreSQL + pgvector
                                      版本原子切换 / 旧版回收
                                                   │
                                                   ▼
                                      Hybrid Search / RAG API
```

Watcher 和 Upload API 都只是同步入口，不各自实现解析逻辑。两者只负责确认来源、保存原文件并创建任务，随后统一经过同一个 Sync Worker。对本地目录而言文件系统是真相来源；对上传文档而言对象存储或受控上传目录是真相来源；数据库保存最后一次成功同步的快照。服务启动时必须执行来源扫描与数据库对账，以补偿停机期间遗漏的事件。

## 3. 数据模型

### 3.1 核心表

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE document_status AS ENUM (
  'pending', 'syncing', 'ready', 'failed', 'deleted'
);

CREATE TABLE knowledge_bases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  root_path       text NOT NULL,
  embedding_model text NOT NULL,
  dimensions      integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_path)
);

CREATE TABLE documents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id   uuid NOT NULL REFERENCES knowledge_bases(id),
  relative_path       text NOT NULL,
  canonical_path      text NOT NULL,
  source_file_id      text,
  source_type         text NOT NULL CHECK (source_type IN ('watched', 'uploaded')),
  source_uri          text NOT NULL,
  owner_id            uuid,
  title               text,
  content_hash        char(64),
  active_version      bigint NOT NULL DEFAULT 0,
  status              document_status NOT NULL DEFAULT 'pending',
  file_size           bigint,
  file_mtime          timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, canonical_path)
);

CREATE TABLE document_chunks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  document_version    bigint NOT NULL,
  chunk_key           text NOT NULL,
  ordinal             integer NOT NULL,
  heading_path        text[] NOT NULL DEFAULT '{}',
  content             text NOT NULL,
  content_hash        char(64) NOT NULL,
  token_count         integer NOT NULL,
  start_line          integer,
  end_line            integer,
  embedding_model     text NOT NULL,
  embedding           vector(1536),
  metadata            jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, document_version, chunk_key)
);

CREATE TABLE sync_jobs (
  id                  bigserial PRIMARY KEY,
  knowledge_base_id   uuid NOT NULL REFERENCES knowledge_bases(id),
  canonical_path      text NOT NULL,
  source_type         text NOT NULL CHECK (source_type IN ('watched', 'uploaded')),
  source_uri          text NOT NULL,
  event_type          text NOT NULL CHECK (event_type IN ('upsert', 'delete', 'reconcile')),
  status              text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'retry', 'done', 'dead')),
  attempts            integer NOT NULL DEFAULT 0,
  available_at        timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chunks_document_version_idx
  ON document_chunks (document_id, document_version);
CREATE INDEX chunks_hash_idx
  ON document_chunks (document_id, content_hash);
CREATE INDEX chunks_metadata_idx
  ON document_chunks USING gin (metadata);
CREATE INDEX chunks_fts_idx
  ON document_chunks USING gin (to_tsvector('simple', content));
CREATE INDEX chunks_embedding_hnsw_idx
  ON document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX sync_jobs_claim_idx
  ON sync_jobs (status, available_at, id);
```

`vector(1536)` 只是采用 1536 维模型时的示例。维度必须和模型输出一致。切换不同维度时，推荐新建知识库或新向量列/表并后台重建，不要在原列上直接混用。

### 3.2 三类标识不要混淆

- `document_id`：数据库内部稳定 ID；路径变化时尽量保持不变。
- `canonical_path`：相对知识库根目录、统一 `/` 分隔符并进行平台约定的大小写规范化，用于定位文件。
- `chunk_key`：Chunk 的逻辑身份，用于在相邻版本间匹配，不等于 Chunk 数组下标。

Windows 上建议保存原始 `relative_path` 用于展示，同时用规范化后的 `canonical_path` 做唯一键。必须校验解析后的绝对路径仍位于知识库根目录内，防止路径穿越和符号链接越界。

## 4. Markdown 结构化切分

### 4.1 切分规则

1. 用 Markdown AST 解析文档，保留 YAML front matter、标题层级、代码块、表格、列表和段落。
2. 以标题树为一级边界。每个 Chunk 都携带完整 `heading_path`，例如 `['部署', 'Docker', '离线安装']`。
3. 标题段落过长时，优先按 AST 块（段落、列表、代码块、表格）继续拆分。
4. 单个代码块或表格原则上不从中间截断；超过模型限制时使用专门规则，并在 metadata 标记被拆分。
5. 建议目标 400～800 tokens，硬上限约 1,000 tokens，重叠 50～100 tokens。最终参数应由真实问答召回评测决定。
6. Embedding 文本建议拼接为：`文档标题 + 标题路径 + 正文`，而展示内容仍保存原正文。

### 4.2 稳定 Chunk Key

仅使用 `heading_path + ordinal` 会在文档头部插入段落后导致后续 Chunk 全部变更；仅使用正文 Hash 又无法区分重复段落。推荐：

```text
section_key = SHA256(normalized heading path)
local_anchor = 当前 AST 块首段的规范化文本摘要
chunk_key   = SHA256(section_key + local_anchor + occurrence)
content_hash = SHA256(normalized embedding input)
```

其中 `occurrence` 用于区分同一章节内相同锚点。匹配时采用两级策略：

1. 首先按 `chunk_key` 精确匹配；
2. 未匹配项在同一 `section_key` 内按 `content_hash` 和相邻顺序匹配，复用完全相同内容的向量。

Hash 计算前只统一换行符、Unicode 形式和非语义尾随空格。不要把所有空白压平，否则代码缩进变化可能被错误视为无变化。

## 5. 同步工作流

### 5.1 本地文件监听入口

- 监听 `add`、`change`、`unlink`，忽略 `.git`、临时文件、备份文件和构建目录；
- 使用 `atomic` 兼容编辑器“写临时文件再重命名”的保存方式；
- 使用约 300～800 ms 的业务层去抖，将同一路径连续事件合并成一次 `upsert`；
- 数据库中同一路径只保留一个尚未执行的最新任务，或通过唯一约束实现任务折叠；
- `unlink` 不立即物理删除，短暂等待后再次检查路径，避免原子保存被误判为删除。

推荐事件语义只有 `upsert` 和 `delete`。Worker 执行时重新检查文件当前状态，而不是盲信旧事件：文件存在就按 upsert，不存在就按 delete，因此乱序和重复事件也是幂等的。

### 5.2 文件上传入口

上传入口与 Watcher 共用后续流水线，但负责接收、校验和持久化原文件：

```text
POST /api/knowledge-bases/:knowledgeBaseId/documents
  multipart/form-data:
    file: *.md / *.mdx
    logicalPath: 可选的知识库内逻辑路径
    conflictMode: reject | replace | version
```

推荐处理过程：

1. 鉴权并检查用户对知识库的写入权限；
2. 校验扩展名、MIME、文件头、UTF-8 编码和大小上限，文件名不能直接作为磁盘路径；
3. 流式计算 SHA-256，写入临时对象，写完后再原子移动到正式位置；
4. 根据 `knowledge_base_id + canonical_path` 判断新增或覆盖；
5. 在数据库事务中创建/更新 `documents`，并写入 `upsert` 类型的 `sync_job`；
6. API 返回 `202 Accepted`、`documentId` 和 `jobId`，不等待 Embedding 完成；
7. 前端轮询 `GET /api/sync-jobs/:jobId` 或通过 SSE/WebSocket 获取状态。

冲突策略应由 API 明确定义：

- `reject`：逻辑路径已存在则返回 `409 Conflict`；
- `replace`：保留相同 `document_id`，将新文件作为下一版本增量同步，适合作为默认值；
- `version`：自动生成新逻辑路径或新文档记录，适合需要并列保留多个文件的场景。

批量上传应为每个文件创建独立任务，并返回一个 `batchId` 汇总进度，避免一个坏文件导致整批回滚。上传原文件推荐存入 S3/MinIO；单机第一阶段也可使用知识库根目录之外的受控存储目录。无论使用哪种存储，Worker 都只通过 `source_uri` 读取内容。

上传文件写入 Watcher 监听目录时，可能同时产生 Upload API 和 Watcher 两个事件。必须通过 `knowledge_base_id + canonical_path + content_hash` 合并任务；更简单的做法是让上传存储目录不处于 Watcher 范围内。

### 5.3 双入口统一规则

- 两个入口统一生成 `upsert` 或 `delete` 任务，不直接调用 Chunker 或 Embedding；
- `source_type='watched'` 的真相来源是本地文件，`source_type='uploaded'` 的真相来源是上传存储；
- 同一逻辑文档只能绑定一个主来源，禁止 Watcher 与上传端无规则地互相覆盖；
- 如果产品要求两种入口能更新同一文档，应使用乐观并发控制：上传时提交已知版本号，不一致返回 `409`；
- Worker 根据任务中的 `source_type + source_uri` 读取当前内容，后续算法完全相同；
- Web UI 应展示来源、当前版本、同步状态、最后成功时间和错误信息。

### 5.4 Worker 增量同步算法

```text
1. 领取任务：SELECT ... FOR UPDATE SKIP LOCKED
2. 对 knowledge_base_id + canonical_path 获取事务级 advisory lock
3. 读取稳定文件快照；读取前后比较 size/mtime，变化则短暂重试
4. 计算整个文件 content_hash
5. 若与 documents.content_hash 相同：更新 mtime，任务完成
6. Markdown AST 切分，生成 chunk_key、content_hash、token_count
7. 读取当前 active_version 的旧 Chunk
8. Diff：
   - unchanged：content_hash、模型和预处理版本都相同，复用 embedding
   - changed/new：批量调用 Embedding
   - removed：不复制到新版本
9. 将“完整的新版本”Chunk 写入 document_chunks
10. 在同一数据库事务中：
    - documents.active_version 指向新版本
    - 更新 content_hash/status/last_synced_at
    - sync_job 标记 done
11. 事务提交后，异步清理旧版本（可保留最近 1～2 版用于回滚）
```

重要：不能先删除线上旧 Chunk，再等待 Embedding。如果模型超时或限流，检索会得到空文档。采用“写新版本 → 原子切换指针 → 清理旧版本”，既有删除后重建的正确语义，也具备生产环境需要的可用性。

### 5.5 删除与重命名

- 删除：将文档标记为 `deleted`，从检索条件中排除，后台再物理清理 Chunk；保留短期墓碑记录，防止延迟的 change 任务把旧内容复活。
- 重命名：Watcher 通常表现为 `unlink + add`。优先使用平台文件标识 `source_file_id`，其次在短时间窗口内用整文件 Hash 匹配，将旧 `document_id` 迁移到新路径。
- 无法确认是重命名时，按“删除旧文档 + 新建文档”处理，结果仍正确，只是不能复用文档级历史。
- 上传文档删除应先检查权限，再标记 `deleted`；原文件进入延迟回收队列，避免误删后无法恢复。
- 上传文档改名只更新逻辑路径和 `source_uri` 映射，不需要重新 Embedding；如果标题路径参与 Embedding 输入，则需按新输入触发重建。

### 5.6 幂等、并发与失败恢复

- 同一路径只允许一个 Worker 同步，用 advisory lock 或锁表保护；
- 每次运行都以文件当前内容为准，重复执行不会生成重复的活动版本；
- Embedding 请求按模型限制批量发送，并设置超时、指数退避和随机抖动；
- 429、超时、5xx 可重试；解析错误、文件过大等确定性错误进入 dead letter；
- 重试间隔示例：5 秒、30 秒、2 分钟、10 分钟、1 小时，最多 8 次；
- Worker 崩溃后，超过租约时间的 `running` 任务重新回到 `retry`；
- 数据库只在所有新向量准备完成后切换版本；失败时保留旧 `active_version`。

## 6. 检索设计

检索 SQL 必须只读取活动版本：

```sql
SELECT
  c.id,
  d.relative_path,
  c.heading_path,
  c.content,
  1 - (c.embedding <=> $1::vector) AS vector_score
FROM document_chunks c
JOIN documents d
  ON d.id = c.document_id
 AND d.active_version = c.document_version
WHERE d.knowledge_base_id = $2
  AND d.status = 'ready'
ORDER BY c.embedding <=> $1::vector
LIMIT $3;
```

成熟的 RAG 不应只用向量检索。建议采用混合检索：

1. pgvector 余弦相似度召回 Top 30～50；
2. PostgreSQL 全文检索召回 Top 30～50，补足精确术语、错误码和变量名；
3. 用 Reciprocal Rank Fusion 合并排序；
4. 可选使用 reranker 重排到 Top 5～10；
5. 返回路径、标题链和行号，支持答案引用与原文定位。

数据量小时先用精确向量检索建立质量基线。Chunk 达到数十万且延迟不满足目标后再启用 HNSW；增加 HNSW 后需用固定评测集验证 recall，不应只看响应时间。带权限或知识库过滤时，还要为过滤列建立普通索引，并验证过滤后的召回数量。

## 7. 模型与预处理版本管理

以下任意变化都可能要求重新 Embedding：

- Embedding 模型或维度；
- Chunking 规则；
- Embedding 输入模板；
- 文本规范化逻辑。

因此每个 Chunk 除 `embedding_model` 外，还应在 metadata 或独立列保存：

```json
{
  "chunker_version": "mdast-v1",
  "normalizer_version": "v1",
  "embedding_template_version": "v1"
}
```

复用向量的条件是 `content_hash + embedding_model + dimensions + 全部预处理版本` 均一致。模型升级采用双写/后台重建，完成后切换知识库配置，不做一次性阻塞迁移。

## 8. 安全、可观测性与运维

### 安全

- 仅允许配置目录下的 `.md`/`.mdx` 文件，限制单文件大小；
- 上传采用流式处理并限制请求体、文件数和解压行为；不信任客户端 MIME 和文件名；
- 上传文件使用服务端生成的对象 Key，原始文件名仅作为展示元数据；
- API 检索必须按 `knowledge_base_id`/`tenant_id` 和 ACL 过滤；
- 日志不记录完整文档和 Embedding 请求正文；
- 云端 Embedding 前明确数据合规边界，敏感项目可切换本地 BGE-M3；
- 数据库连接、模型密钥通过 Secret/环境变量注入。

### 指标

- `sync_queue_depth`、`sync_lag_seconds`；
- 同步成功率、重试率、dead job 数；
- Chunk 新增/修改/复用/删除数量；
- Embedding 请求延迟、Token 数、费用、限流次数；
- 每次检索耗时、零结果率、Top-K recall 与引用命中率。

日志需带 `job_id`、`document_id`、`canonical_path`、`document_version` 和 `trace_id`，但对内容做脱敏。

### 定时对账

即使有 Watcher 和上传回调，也应：

- 启动时全量扫描；
- 每 10～30 分钟进行轻量对账（路径、mtime、size）；
- 每天抽样或分批计算内容 Hash 深度对账；
- 将磁盘不存在但数据库仍为 ready 的文档入 delete 队列。
- 对上传来源定期检查对象是否存在、Hash 是否一致，并清理无数据库引用的孤立临时对象。

## 9. 验收标准

### 功能验收

- 新建 Markdown 后能够检索；
- API 上传 Markdown 返回任务 ID，任务完成后能够检索并定位原文；
- 同路径覆盖上传只更新变化 Chunk，不产生重复活动 Chunk；
- `reject/replace/version` 三种上传冲突模式结果符合定义；
- 批量上传中单个文件失败不影响其他文件完成；
- 修改一个 Chunk 时，只有变化 Chunk 请求 Embedding；
- 插入开头段落不会导致所有后续 Chunk 重新向量化；
- 连续保存 10 次最终只同步最新内容，无重复活动 Chunk；
- 文件删除后不再被检索；重命名后新路径可检索；
- 服务停机期间修改文件，重启扫描后能补齐；
- Upload API 与 Watcher 对同一内容重复触发时只产生一个有效版本；
- 未授权用户不能上传、覆盖、删除或检索其他知识库的文档；
- Embedding 失败时仍能检索旧版本，恢复后自动切换；
- 模型或 chunker 版本变化能触发受控重建。

### 性能目标（第一阶段建议值）

- 95% 的普通文件在保存后 5 秒内完成同步（不含模型严重限流）；
- 未修改 Chunk 的向量复用率大于 95%；
- 10 万 Chunk 下检索 P95 小于 300 ms；
- 活动版本重复 Chunk 数为 0；
- 同步任务最终成功率大于 99.9%。

## 10. 分阶段落地计划

### Phase 1：可靠闭环

- PostgreSQL/pgvector 建表与迁移；
- Chokidar 监听、去抖、启动扫描；
- Upload API、文件校验、受控存储、覆盖策略和任务状态接口；
- Watcher 与 Upload API 统一写入 `sync_jobs`；
- Markdown AST 切分；
- 全文件 Hash 短路 + Chunk Hash 增量 Embedding；
- 版本化写入和原子切换；
- 删除、重试、dead job、基础指标；
- 精确向量检索及引用信息返回。

### Phase 2：质量与规模

- 混合检索、RRF、可选 reranker；
- HNSW 与过滤索引；
- 重命名识别、ACL、多知识库；
- 管理界面展示同步状态和手动重建；
- 基于真实问答集的 Chunk 参数与召回评测。

### Phase 3：大规模演进

- Redis/BullMQ 或消息队列；
- 多 Worker 横向扩容；
- 独立向量数据库评估；
- 模型双写迁移、冷热数据和分区策略。

## 11. 最终建议

第一版应优先做好“正确、幂等、可恢复”，而不是追求复杂的局部文本 diff。最佳投入顺序是：

1. 全文件 Hash 避免无意义同步；
2. AST Chunk + 稳定 `chunk_key`；
3. Chunk Hash 复用未变化向量；
4. 新版本完整写入并原子切换；
5. 持久化任务、失败重试和启动对账；
6. 有真实数据后再用评测决定 HNSW、Chunk 大小与 reranker。

这套方案既适合当前从零建设，也保留了向专用队列和专用向量数据库演进的边界，不会因早期过度设计增加运维负担。
