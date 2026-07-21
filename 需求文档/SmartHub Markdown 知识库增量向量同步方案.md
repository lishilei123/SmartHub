# SmartHub 项目知识库 Markdown/纯文本增量向量同步方案

> **文档定位**：本方案是 [第一期-项目知识库构建与配置需求文档.md](第一期-项目知识库构建与配置需求文档.md) 的技术实现参考，术语和范围以该需求文档及 [需求文档.md](需求文档.md) 为准。
>
> **范围约束**：本文只描述 Markdown/纯文本知识资产的接入、版本、同步、索引和基础检索。AI 需求分析、AI 技术方案分析、Git/代码、测试执行、权限治理和专用格式解析器均不属于第一期实现范围。
>
> **资料边界**：独立维护的项目资料统一建模为知识资产及资产版本，不再以“分析工作区”和“正式知识库”划分两套资料库。AI 中间产物仅在人工保存为独立资料版本后，才可按本方案进入同步与检索。

## 1. 目标与结论

目标是将项目内的 Markdown/纯文本知识资产持续同步到可检索的项目知识库，并保证：

- 资料保存或接入后自动进入同步，通常在数秒内可检索；
- 同一资料反复修改不会产生重复资产版本或重复活动 Chunk；
- 只为新增或内容变化的 Chunk 调用 Embedding；
- 同步失败时继续使用上一个成功资产版本和活动索引，避免检索出现空窗；
- 正确处理新增、修改、删除、重命名、连续保存和服务重启；
- 可追踪每个资产版本的同步状态、错误原因、Token 用量和模型版本；
- 配置变更以候选索引构建和原子切换生效，避免在活动索引中混用不兼容的向量；
- 本期完整支持 Markdown/纯文本；需求、技术方案、API 文本、测试用例和测试报告等通过统一资产类型表达。

第一期优先级是“正确、幂等、可恢复”，而不是复杂的局部文本 Diff 或过早引入分布式基础设施。

## 2. 推荐技术栈

| 模块 | 选型 | 原因 |
|---|---|---|
| 应用 | Node.js 22 + TypeScript | 与 Chokidar、Markdown 解析生态结合简单。 |
| 文件监听 | Chokidar | 统一处理 add/change/unlink 和编辑器原子写入。 |
| 文件上传 | HTTP API + 对象存储/受控目录 | 支持网页上传、覆盖更新和批量导入。 |
| Markdown 解析 | unified + remark-parse + mdast-util-to-string | 基于 AST，避免正则或字数硬切。 |
| 纯文本解析 | 段落/行区间切分器 | 保留文本结构和可定位的原文区间。 |
| 主数据库 | PostgreSQL 16+ | 同时管理资产、版本、任务和事务。 |
| 向量扩展 | pgvector 0.8+ | 早期无需维护独立向量数据库，支持精确检索和 HNSW。 |
| 队列 | PostgreSQL Job 表 | 单机和中小规模足够可靠；规模扩大后可替换为 Redis/BullMQ。 |
| Embedding | 可插拔 Provider | 云端可用 `text-embedding-3-small`，本地可用 BGE-M3。 |

不建议第一版同时引入 Qdrant/Milvus 与 PostgreSQL 两套存储。只有向量达到千万级、需要独立扩缩容或高级向量检索能力时，再评估迁移专用向量数据库。

## 3. 总体架构

```text
受控本地资料目录 ── File Watcher ──┐
                                    ├──> sync_jobs（持久化队列）
网页/API 上传 ───── Upload API ──────┘             │
                                                   ▼
                                            Sync Worker
                         ┌────────────┼────────────┐
                         │            │            │
                    读取资料快照   结构化切分    Hash/Diff
                                                   │
                                    仅新增/变化 Chunk Embedding
                                                   │
                                                   ▼
                                      PostgreSQL + pgvector
                                      候选索引构建 / 原子切换
                                                   │
                                                   ▼
                                       基础关键词/向量检索 API
```

Watcher 和 Upload API 都只是同步入口，不各自实现解析逻辑。两者只负责确认来源、保存原始资料并创建任务，随后统一经过同一个 Sync Worker。

- 受控目录资料以文件系统为真相来源；
- 上传资料以对象存储或受控上传目录为真相来源；
- 数据库保存最后一次成功同步的资产版本快照和活动索引指针；
- 服务启动时必须执行来源扫描与数据库对账，以补偿停机期间遗漏的事件；
- 上传存储目录不应位于 Watcher 监听范围内；若无法隔离，必须以 `knowledge_base_id + canonical_path + content_hash` 合并重复任务。

## 4. 数据模型

### 4.1 核心对象

```text
项目
  └─ 默认项目知识库
       └─ 知识资产
            └─ 不可变资产版本
                 └─ Chunk

默认项目知识库
  └─ 索引版本（由固定范围的资产版本构成）
```

- **知识资产**代表同一逻辑资料，例如“支付重构技术方案”。它拥有稳定 `asset_id`，不以文件名或路径作为唯一身份。
- **资产版本**代表某次不可变内容快照。它记录内容 Hash、来源、逻辑路径、资料类型、解析/Embedding 配置快照和同步状态。
- **Chunk**属于确定资产版本，记录稳定 `chunk_key`、内容 Hash、标题路径和原文定位。
- **索引版本**对应固定配置与固定资产版本范围。候选索引校验完成后，才可以原子成为活动索引。

### 4.2 逻辑表

以下为第一期逻辑模型。实现可以调整物理表名，但不得丢失知识资产、资产版本、Chunk、索引版本与同步任务之间的关系。

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE asset_version_status AS ENUM (
  'pending', 'syncing', 'ready', 'failed', 'deleted'
);

CREATE TABLE knowledge_bases (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL,
  name                    text NOT NULL,
  root_path               text,
  active_index_version_id uuid,
  config_version          bigint NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE knowledge_assets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id     uuid NOT NULL REFERENCES knowledge_bases(id),
  display_name          text NOT NULL,
  asset_type            text NOT NULL,
  relative_path         text NOT NULL,
  canonical_path        text NOT NULL,
  active_version_id     uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_base_id, canonical_path)
);

CREATE TABLE asset_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id              uuid NOT NULL REFERENCES knowledge_assets(id),
  source_type           text NOT NULL CHECK (source_type IN ('directory_watch', 'upload')),
  source_uri            text NOT NULL,
  source_file_id        text,
  content_hash          char(64) NOT NULL,
  status                asset_version_status NOT NULL DEFAULT 'pending',
  file_size             bigint,
  file_mtime            timestamptz,
  parser_snapshot       jsonb NOT NULL DEFAULT '{}',
  embedding_snapshot    jsonb NOT NULL DEFAULT '{}',
  last_synced_at        timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, content_hash)
);

CREATE TABLE asset_chunks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_version_id      uuid NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  chunk_key             text NOT NULL,
  ordinal               integer NOT NULL,
  heading_path          text[] NOT NULL DEFAULT '{}',
  content               text NOT NULL,
  content_hash          char(64) NOT NULL,
  token_count           integer NOT NULL,
  start_line            integer,
  end_line              integer,
  embedding_model       text NOT NULL,
  embedding             vector(1536),
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_version_id, chunk_key)
);

CREATE TABLE index_versions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_base_id     uuid NOT NULL REFERENCES knowledge_bases(id),
  status                text NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'cancelled')),
  config_snapshot       jsonb NOT NULL,
  asset_version_scope   jsonb NOT NULL,
  activated_at          timestamptz,
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sync_jobs (
  id                    bigserial PRIMARY KEY,
  knowledge_base_id     uuid NOT NULL REFERENCES knowledge_bases(id),
  asset_id              uuid REFERENCES knowledge_assets(id),
  asset_version_id      uuid REFERENCES asset_versions(id),
  canonical_path        text NOT NULL,
  source_type           text NOT NULL CHECK (source_type IN ('directory_watch', 'upload')),
  source_uri            text NOT NULL,
  event_type            text NOT NULL CHECK (event_type IN ('upsert', 'delete', 'reconcile', 'rebuild')),
  status                text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts              integer NOT NULL DEFAULT 0,
  available_at          timestamptz NOT NULL DEFAULT now(),
  locked_at             timestamptz,
  locked_by             text,
  config_snapshot       jsonb NOT NULL DEFAULT '{}',
  last_error            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX asset_chunks_version_idx
  ON asset_chunks (asset_version_id);
CREATE INDEX asset_chunks_hash_idx
  ON asset_chunks (content_hash);
CREATE INDEX asset_chunks_metadata_idx
  ON asset_chunks USING gin (metadata);
CREATE INDEX asset_chunks_fts_idx
  ON asset_chunks USING gin (to_tsvector('simple', content));
CREATE INDEX asset_chunks_embedding_hnsw_idx
  ON asset_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX sync_jobs_claim_idx
  ON sync_jobs (status, available_at, id);
```

`vector(1536)` 只是采用 1536 维模型时的示例。维度必须和模型输出一致。切换不同维度时，必须创建候选索引版本并后台重建，不得在活动索引中直接混用。

### 4.3 关键标识与路径

- `asset_id`：知识资产稳定 ID；路径变化时应尽量保持不变。
- `asset_version_id`：知识资产不可变内容快照 ID；所有检索引用必须指向该版本。
- `canonical_path`：相对受控资料根目录或知识库逻辑根目录、统一 `/` 分隔符并按平台约定规范化大小写后的逻辑路径。
- `chunk_key`：Chunk 的逻辑身份，用于在相邻资产版本间匹配，不等于数组下标。
- `content_hash`：对规范化内容或规范化 Embedding 输入计算的 SHA-256。

Windows 上应保存原始 `relative_path` 用于展示，同时用 `canonical_path` 识别同一路径资料。必须校验解析后的绝对路径仍位于受控目录内，防止路径穿越和符号链接越界。

## 5. 结构化解析与稳定切分

### 5.1 Markdown 切分规则

1. 使用 Markdown AST 解析，保留 YAML front matter、标题层级、代码块、表格、列表和段落。
2. 以标题树为一级边界。每个 Chunk 携带完整 `heading_path`，例如 `['部署', 'Docker', '离线安装']`。
3. 标题内容过长时，优先按 AST 块继续拆分。
4. 单个代码块或表格原则上不从中间截断；超过模型限制时采用专门规则，并在元数据标记被拆分。
5. 目标为 400～800 tokens，硬上限约 1,000 tokens，重叠 50～100 tokens；最终值由真实检索评测决定。
6. Embedding 输入建议为“资料标题 + 标题路径 + 正文”，展示内容仍保留原正文。

### 5.2 纯文本切分规则

1. 优先以空行分隔的段落为切分边界；段落过长时按自然行区间或句子边界继续拆分。
2. 每个 Chunk 记录起止行号或字符区间，保证检索结果可回到原文。
3. 纯文本使用稳定的局部文本锚点和序号生成 `chunk_key`，同样复用未变化内容的向量。

### 5.3 稳定 Chunk Key

只使用 `heading_path + ordinal` 会在资料头部插入内容后导致大量无意义变化；只使用正文 Hash 又无法区分重复段落。推荐：

```text
section_key  = SHA256(normalized heading path)
local_anchor = 当前 AST 块首段的规范化文本摘要
chunk_key    = SHA256(section_key + local_anchor + occurrence)
content_hash = SHA256(normalized embedding input)
```

匹配采用两级策略：

1. 按 `chunk_key` 精确匹配；
2. 对未匹配项，在相同 `section_key` 内按 `content_hash` 与相邻顺序匹配，复用完全相同内容的向量。

Hash 计算前只统一换行符、Unicode 形式和非语义尾随空格。不得将全部空白压平，否则代码缩进变化可能被错误视为无变化。

## 6. 统一接入与同步工作流

### 6.1 受控目录监听

- 监听 `add`、`change`、`unlink`，忽略临时文件、备份文件、构建目录和监听范围外路径；
- 使用 `atomic` 兼容编辑器“写临时文件再重命名”的保存方式；
- 使用约 300～800 ms 的业务层去抖，将同一路径连续事件合并为一次 `upsert`；
- 同一路径只保留一个尚未执行的最新任务，或用唯一约束折叠任务；
- `unlink` 不立即物理删除，应短暂复查路径，避免原子保存被误判为删除；
- Worker 执行时重新检查资料当前状态：存在则 `upsert`，不存在则 `delete`，使乱序和重复事件幂等。

### 6.2 上传入口

上传入口与 Watcher 共用后续流水线，只负责接收、校验和持久化原始资料：

```text
POST /api/knowledge-bases/:knowledgeBaseId/assets
  multipart/form-data:
    file: *.md / *.txt
    assetType: requirement | technical_design | architecture | api_spec |
               data_dictionary | test_case | test_report | defect_review | other
    logicalPath: 可选的知识库内逻辑路径
    conflictMode: reject | new_version | parallel_asset
```

推荐处理过程：

1. 校验扩展名、文件头、UTF-8 编码和大小上限；文件名不能直接作为磁盘路径；
2. 流式计算 SHA-256，写入临时对象，完成后原子移动至受控存储；
3. 依据 `knowledge_base_id + canonical_path` 识别资产和冲突策略；
4. 内容 Hash 与当前版本相同则复用成功结果；内容变化则创建不可变资产版本与 `upsert` 任务；
5. API 返回 `202 Accepted`、`assetId`、`assetVersionId` 和 `jobId`，不等待 Embedding 完成；
6. 前端轮询 `GET /api/sync-jobs/:jobId` 或通过 SSE 获取任务状态。

冲突策略：

- `reject`：逻辑路径存在则返回 `409 Conflict`；
- `new_version`：保留同一 `asset_id`，将新内容作为下一不可变资产版本；
- `parallel_asset`：创建并列资产，要求不同显示名称，并在检索中明确显示来源和路径。

### 6.3 双入口统一规则

- 两个入口统一生成 `upsert`、`delete`、`reconcile` 或 `rebuild` 任务，不直接调用 Chunker 或 Embedding；
- `source_type='directory_watch'` 的真相来源是本地文件，`source_type='upload'` 的真相来源是上传存储；
- 同一路径由多个来源覆盖时，按已保存的冲突策略处理，不允许无规则互相覆盖；
- Worker 依据任务中的 `source_type + source_uri` 读取当前内容，后续算法完全一致；
- 知识库界面展示来源、资产版本、同步状态、最近成功时间和最近错误。

### 6.4 Worker 增量同步算法

```text
1. 领取任务：SELECT ... FOR UPDATE SKIP LOCKED
2. 对 knowledge_base_id + canonical_path 获取事务级 advisory lock
3. 读取稳定资料快照；读取前后比较 size/mtime，变化则短暂重试
4. 计算整体 content_hash
5. 若与当前资产版本相同：更新来源元数据，任务成功结束
6. 解析 Markdown/纯文本，生成 chunk_key、chunk content_hash、token_count 和原文定位
7. 读取上一成功资产版本的 Chunk
8. Diff：
   - unchanged：内容、模型和预处理版本均相同，复用 embedding
   - changed/new：批量调用 Embedding
   - removed：不复制至候选版本
9. 写入完整候选资产版本 Chunk，并建立候选索引版本
10. 校验完成后，在同一事务中：
    - 切换 knowledge_assets.active_version_id
    - 切换 knowledge_bases.active_index_version_id
    - 更新 asset_version.status/last_synced_at
    - 标记 sync_job 为 succeeded
11. 异步回收不再需要的历史 Chunk；保留资产版本和索引版本元数据以供追溯
```

不能先删除活动索引中的旧 Chunk，再等待 Embedding。模型超时或限流时会导致检索空窗。正确顺序是“写候选版本 → 校验 → 原子切换指针 → 延后回收旧数据”。

### 6.5 删除、重命名与连续保存

- 删除：创建删除对账任务。候选索引成功切换后，资产版本标记为 `deleted` 并从默认检索排除；可保留墓碑记录，避免延迟 `change` 事件复活旧内容。
- 重命名：优先使用平台文件标识 `source_file_id`，其次在短窗口内以整体 Hash 匹配，保留同一 `asset_id` 并更新逻辑路径。
- 无法确认重命名时，按“删除旧资产 + 新建资产”处理，保证结果正确；资产历史复用属于优化而非正确性前提。
- 上传资料改名仅更新逻辑路径和来源映射；若标题或路径参与 Embedding 输入，则创建候选版本重新切分/Embedding。
- 连续保存、重复上传或重复监听事件应由内容 Hash、路径锁和任务折叠共同去重。

### 6.6 失败、重试、取消与恢复

- 同一路径只允许一个 Worker 同步，使用 advisory lock 或锁表保护；
- Embedding 请求按模型限制批量发送，并设置超时、指数退避和随机抖动；
- 429、超时、5xx 可重试；解析错误、文件过大、编码非法等确定性错误标记失败；
- 重试间隔示例：5 秒、30 秒、2 分钟、10 分钟、1 小时，最多 8 次；
- Worker 崩溃后，超过租约时间的 `running` 任务重新进入可领取状态；
- 取消任务只清理未提交候选结果，标记 `cancelled`，不修改活动索引；
- 数据库仅在所有候选 Chunk 和向量准备完成后切换活动指针；失败或取消时保留旧活动版本。

### 6.7 来源对账

即使存在 Watcher 和上传回调，也应：

- 服务启动时执行受控目录完整扫描；
- 每 10～30 分钟进行轻量对账，比较路径、mtime 和 size；
- 每天抽样或分批执行内容 Hash 深度对账；
- 将来源不存在但数据库仍为 `ready` 的资产加入删除队列；
- 对上传来源检查对象是否存在、Hash 是否一致，并回收无数据库引用的临时对象；
- 记录扫描范围、发现量、变更量、未处理项和错误；无变化时不创建无效索引版本。

## 7. 检索与原文定位

### 7.1 活动索引查询

检索只读取当前活动索引范围内的 `ready` 资产版本。逻辑查询必须能返回 `asset_id`、`asset_version_id`、资料类型、来源、逻辑路径、标题路径、Chunk 标识和原文定位。

```sql
SELECT
  c.id AS chunk_id,
  a.id AS asset_id,
  v.id AS asset_version_id,
  a.asset_type,
  a.relative_path,
  c.heading_path,
  c.start_line,
  c.end_line,
  c.content,
  1 - (c.embedding <=> $1::vector) AS vector_score
FROM asset_chunks c
JOIN asset_versions v ON v.id = c.asset_version_id
JOIN knowledge_assets a ON a.id = v.asset_id
JOIN knowledge_bases kb ON kb.id = a.knowledge_base_id
WHERE kb.id = $2
  AND v.status = 'ready'
  AND a.active_version_id = v.id
ORDER BY c.embedding <=> $1::vector
LIMIT $3;
```

具体实现可由索引版本范围表进一步限定。关键要求是：结果不能自动替换为同一资产的当前最新内容，打开结果必须回到引用的固定资产版本与原文位置。

### 7.2 基础混合检索

第一期可先采用精确向量检索建立质量基线，并提供关键词检索。混合检索建议：

1. pgvector 余弦相似度召回 Top 30～50；
2. PostgreSQL 全文检索召回 Top 30～50，补足精确术语、错误码和变量名；
3. 用 Reciprocal Rank Fusion 合并排序；
4. 根据首期资源可选 reranker，不作为交付依赖；
5. 返回资料路径、标题链和行号，支持后续分析的证据引用。

Chunk 达到数十万且延迟不满足目标后再启用 HNSW；启用前后均应使用固定评测集验证召回质量，而不是只观察响应时间。

## 8. 配置与索引重建

### 8.1 需要记录的配置快照

资产版本、Chunk、同步任务和索引版本至少记录：

```json
{
  "parser_version": "mdast-v1",
  "normalizer_version": "v1",
  "chunker_version": "mdast-v1",
  "embedding_model": "text-embedding-3-small",
  "dimensions": 1536,
  "embedding_template_version": "v1"
}
```

以下变更会影响索引兼容性：

- Embedding 模型或维度；
- Markdown/纯文本解析与 Chunking 规则；
- Embedding 输入模板；
- 文本规范化逻辑。

复用向量的前提是 `content_hash + embedding_model + dimensions + 全部预处理版本` 一致。

### 8.2 受控重建

1. 用户保存影响索引兼容性的配置时，系统显示影响范围和旧活动索引版本；
2. 用户确认后创建 `rebuild` 任务，生成带新配置快照的候选索引版本；
3. 重建期间旧活动索引持续提供检索；首次建库没有旧索引时，明确提示向量检索暂不可用；
4. 候选版本通过完整性校验后，单次更新活动索引指针；
5. 失败或取消时，旧活动索引保持不变；
6. 保留新旧索引元数据、处理范围和配置快照，支持追溯与问题排查。

模型升级采用候选索引重建，不做一次性阻塞迁移。

## 9. 安全、可观测性与运维

### 9.1 第一期开销与安全边界

第一期不实现用户权限、ACL 或审批，但仍必须处理系统边界安全：

- 仅允许配置目录下的 `.md`、`.txt` 文件，并限制单文件大小；
- 上传采用流式处理并限制请求体、文件数和解压行为；不信任客户端 MIME 和文件名；
- 上传文件使用服务端生成的对象 Key，原始文件名只作为展示元数据；
- 校验目录路径和符号链接，避免访问受控目录之外的文件；
- 日志不记录完整资料内容和 Embedding 请求正文；
- 云端 Embedding 前明确数据传输与存储边界，敏感项目可选本地 Provider；
- 数据库连接和模型密钥通过 Secret/环境变量注入。

### 9.2 指标与日志

建议记录：

- `sync_queue_depth`、`sync_lag_seconds`；
- 同步成功率、重试率、失败和取消任务数量；
- Chunk 新增/修改/复用/删除数量；
- Embedding 请求延迟、Token 数、费用和限流次数；
- 检索耗时、零结果率、Top-K recall 与引用定位命中率；
- 索引重建耗时、候选/活动版本切换次数和失败率。

日志应包含 `job_id`、`asset_id`、`asset_version_id`、`canonical_path`、`index_version_id` 和 `trace_id`，但对资料内容脱敏。

## 10. 第一阶段验收映射

| 验收主题 | 本方案实现重点 |
|---|---|
| Markdown/纯文本接入 | Upload API、受控目录、编码/路径校验、统一任务链路。 |
| 统一资产模型 | 资料类型为资产元数据；版本化需求、技术方案、API 文本、测试资产使用同一模型。 |
| 增量同步 | 整体 Hash 短路、稳定 `chunk_key`、Chunk Hash 和向量复用。 |
| 失败恢复 | 候选写入、重试、取消、旧活动索引保留。 |
| 删除与重命名 | 墓碑、来源对账、路径与文件标识匹配。 |
| 基础检索 | 当前活动资产版本、关键词/向量召回、固定版本与原文定位。 |
| 配置重建 | 配置快照、候选索引、原子切换与旧索引持续可用。 |

建议性能基线：

- 95% 的普通 Markdown/纯文本资料在保存后 5 秒内完成同步（不含模型严重限流）；
- 未变化 Chunk 的向量复用率大于 95%；
- 10 万 Chunk 下检索 P95 小于 300 ms；
- 活动索引中重复 Chunk 数为 0；
- 同步任务最终成功率大于 99.9%。

这些指标需以首期试点资料规模、Embedding Provider 限流和检索评测集校准，不应在没有真实样本前作为不可调整的上线门槛。

## 11. 实现迭代建议

本节是技术实现迭代，不等同于产品 Phase 1/2/3 路线。

### 迭代 A：可靠基础

- PostgreSQL/pgvector 建表与迁移；
- Chokidar 监听、去抖、启动扫描；
- Upload API、文件校验、受控存储、冲突策略与任务状态接口；
- Watcher 与 Upload API 统一写入 `sync_jobs`；
- Markdown AST 与纯文本切分；
- 整体 Hash 短路、Chunk Hash 增量 Embedding；
- 资产版本化写入、候选索引与原子切换；
- 删除、重试、取消、来源对账、基础指标；
- 关键词/精确向量检索及引用信息返回。

### 迭代 B：质量与规模优化

- 混合检索、RRF、可选 reranker；
- HNSW 与固定检索评测集；
- 更完善的重命名识别；
- 管理界面展示任务、索引版本、配置草稿与手动重建；
- 以真实问答集调整 Chunk 参数和召回质量。

### 迭代 C：规模化演进

- Redis/BullMQ 或消息队列；
- 多 Worker 横向扩容；
- 独立向量数据库评估；
- 模型双写迁移、冷热数据和分区策略。

多知识库、Git/外部系统来源、细粒度权限与审批不包含在本方案的第一期实现中，应按产品总览的后续阶段单独设计。
