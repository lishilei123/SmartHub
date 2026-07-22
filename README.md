# SmartHub Phase 1

当前仓库已按《第一期：项目知识库构建与配置需求文档》实现可运行的一期资料接入与检索闭环，同时保留后续阶段的产品原型页面。

## 已实现

- 创建项目时自动创建唯一默认知识库；
- 页面启动时由后端解析并复用唯一的 SmartHub 默认知识库，不依赖浏览器 localStorage 决定数据归属，刷新、切换访问域名或开发模式重复挂载不会创建并切换到新空库；
- UTF-8 Markdown/TXT 支持单文件上传、一次多选批量上传，也可通过 ZIP 批量导入；ZIP 保留子目录结构，并支持 Markdown 以相对路径引用其中的 PNG、JPG、GIF、WebP 和 SVG 图片；
- 知识库目录创建、重命名、移动和递归删除持久化到 PostgreSQL；选中目录后上传会自动使用对应逻辑路径；
- 知识文件可从文件树或预览区执行重命名、跨目录移动和删除；操作同步更新 PostgreSQL、活动索引及默认文件目录，删除时保留不可变版本快照；
- 稳定资产、不可变资产版本、内容 Hash 去重与稳定 Chunk；Markdown 使用 AST 结构边界和模型实际 tokenizer 切分，目标/最大 Token 数、相邻重叠、代码块与表格完整性均进入切分流程；
- 未变化 Chunk 的 Embedding 复用和变化 Chunk 增量处理；
- 上传只固化不可变快照并创建持久化 `queued` 任务，由 Worker 异步完成解析、Embedding 和索引发布；
- 同步/重建任务、进度、失败重试、取消、中断恢复和旧活动索引连续可用；
- 候选索引在任务、配置、成员范围和向量维度校验后的条件事务切换；重建不改写不可变资产版本 Chunk；
- 配置版本、查询配置即时生效和兼容配置受控重建；
- SmartHub 内置本地模型运行时：直接拉取 Hugging Face Transformers.js 兼容模型、显示真实进度并在 API 进程内完成向量推理；远程模式调用 OpenAI 兼容的 `/embeddings` API，失败时明确失败而不降级为 Hash 向量；
- 资产/版本浏览及关键词、向量、混合检索；PostgreSQL 使用 pgvector 和 HNSW 执行向量召回、pg_trgm 执行关键词召回，再按配置的两路召回数量融合并执行二阶段语义重排；向量服务故障时混合检索降级到关键词，纯向量返回明确不可用状态；
- 检索结果绑定固定资产版本、标题路径、Chunk 和原文行号；
- AC-001～AC-009 自动化验收场景。

本地开发默认通过 `.env.local` 的 `DATABASE_URL` 使用 PostgreSQL；项目、知识库、配置版本、资产、不可变版本、资产 Chunk、索引固定 Chunk 和任务分别写入 `smarthub` schema。写事务在数据库锁内读取最新状态并只对变化实体执行 UPSERT/定向删除，不再全库 `TRUNCATE + 重写`。Chunk 向量使用 pgvector 的 `vector` 类型，并为默认384维模型建立 HNSW 余弦索引。首次连接时会安装可用的 `vector`、`pg_trgm` 扩展、自动建表或迁移旧向量。未配置 `DATABASE_URL` 时回退到 JSON 文件和进程内精确检索。

生产 API 注入 SmartHub 内置模型运行时，本地模式下上传解析、索引重建和向量/混合检索均使用当前运行模型；上传或检索发现模型未运行时，系统会自动拉取并启动所选模型。单元测试通过运行时接口注入轻量测试模型，不下载大模型。

## 本地运行

安装依赖：

```powershell
$ErrorActionPreference = 'Stop'
npm install
```

同时启动 API 与 Web：

```powershell
$ErrorActionPreference = 'Stop'
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`，从左侧进入唯一的“知识库”。API 默认监听 `http://127.0.0.1:8787`。网页先启动时会自动重试 API 连接，连接成功后“刷新”和“上传资料”自动恢复可用。上传 ZIP 时可指定目标目录；压缩包内的 Markdown/TXT 会异步进入索引，图片作为本地附件保存并用于安全预览，其他类型会跳过。

数据库连接写在不提交 Git 的 `.env.local` 中，可参考 `.env.example`。数据库需预先存在，并且 PostgreSQL 实例需要提供 pgvector；扩展与表结构由 API 自动创建：

```powershell
$ErrorActionPreference = 'Stop'
$env:PGPASSWORD = '<本机 postgres 密码>'
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -h 'localhost' -p '5432' -U 'postgres' -d 'postgres' -c 'CREATE DATABASE smarthub'
Remove-Item Env:PGPASSWORD
```

知识库配置选择“本地模型”后，点击“拉取并启动”。模型由 SmartHub API 进程直接运行，不需要安装 Ollama，也不需要填写本地地址。默认目录如下：

- 模型缓存：`data/models/cache`
- 当前上传文件：`data/knowledge-bases/{knowledgeBaseId}/files/{logicalPath}`
- 不可变版本快照：`data/knowledge-bases/{knowledgeBaseId}/versions/{assetVersionId}/source.md|txt`

可用 `SMARTHUB_MODEL_ROOT` 和 `SMARTHUB_DOCUMENT_ROOT` 覆盖系统级存储根目录；服务器无法直连 Hugging Face 时，可用 `SMARTHUB_MODEL_HUB` 指定系统统一的兼容镜像地址。`SMARTHUB_DATA_FILE` 仅用于未配置 PostgreSQL 时的 JSON 回退。以上均为部署级配置，前端不提供按知识库自定义物理目录或模型地址的配置。

## 验证

```powershell
$ErrorActionPreference = 'Stop'
npm test
npm run build
```

测试覆盖真实 Token 计数、最大长度、重叠和代码块保护、上传入队、处理中取消、候选索引切换、重复上传短路、局部 Chunk 复用、远程 Embedding 请求与失败语义、检索自动降级、两路召回数量、Reranker、系统默认目录落盘、不可变原文快照、失败保留旧索引、固定版本证据和配置重建。

## 接口摘要

- `POST /api/projects`
- `POST /api/default-knowledge-base`
- `GET /api/local-model/status`
- `POST /api/local-model/start`
- `POST /api/local-model/stop`
- `GET /api/knowledge-bases/:id/overview`
- `GET|PUT /api/knowledge-bases/:id/config`
- `POST /api/knowledge-bases/:id/embedding/test`
- `POST /api/knowledge-bases/:id/uploads`
- `POST /api/knowledge-bases/:id/archives`
- `GET /api/knowledge-bases/:id/files/*`
- `GET /api/knowledge-bases/:id/assets`
- `DELETE /api/assets/:id`
- `GET /api/asset-versions/:id`
- `GET /api/knowledge-bases/:id/tasks`
- `GET /api/tasks/:id`
- `POST /api/tasks/:id/retry`
- `POST /api/tasks/:id/cancel`
- `POST /api/knowledge-bases/:id/search`
- `POST /api/knowledge-bases/:id/rebuild`

一期明确不包含 AI 需求分析、AI 对话、Git/代码分析、测试执行、权限治理以及 PDF/Word/Excel/OpenAPI 专用解析器。
