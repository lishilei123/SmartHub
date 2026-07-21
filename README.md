# SmartHub Phase 1

当前仓库已按《第一期：项目知识库构建与配置需求文档》实现可运行的一期资料接入与检索闭环，同时保留后续阶段的产品原型页面。

## 已实现

- 创建项目时自动创建唯一默认知识库；
- 页面启动时由后端解析并复用唯一的 SmartHub 默认知识库，不依赖浏览器 localStorage 决定数据归属，刷新、切换访问域名或开发模式重复挂载不会创建并切换到新空库；
- UTF-8 Markdown/TXT 支持单文件上传、一次多选批量上传，也可通过 ZIP 批量导入；ZIP 保留子目录结构，并支持 Markdown 以相对路径引用其中的 PNG、JPG、GIF、WebP 和 SVG 图片；
- 知识库目录创建、重命名、移动和递归删除持久化到 PostgreSQL；选中目录后上传会自动使用对应逻辑路径；
- 知识文件可从文件树或预览区执行重命名、跨目录移动和删除；操作同步更新 PostgreSQL、活动索引及默认文件目录，删除时保留不可变版本快照；
- 稳定资产、不可变资产版本、内容 Hash 去重与稳定 Chunk；
- 未变化 Chunk 的 Embedding 复用和变化 Chunk 增量处理；
- 同步/重建任务、进度、失败重试、取消和旧活动索引连续可用；
- 候选索引校验后的活动索引原子切换；
- 配置版本、查询配置即时生效和兼容配置受控重建；
- SmartHub 内置本地模型运行时：直接拉取 Hugging Face Transformers.js 兼容模型、显示真实进度并在 API 进程内完成向量推理；
- 资产/版本浏览及关键词、向量、混合检索；
- 检索结果绑定固定资产版本、标题路径、Chunk 和原文行号；
- AC-001～AC-009 自动化验收场景。

本地开发默认通过 `.env.local` 的 `DATABASE_URL` 使用 PostgreSQL；项目、知识库、配置版本、资产、不可变版本、Chunk、索引和任务分别写入 `smarthub` schema。首次连接空数据库时会自动建表，并把现有 `data/smarthub.json` 数据迁入 PostgreSQL。未配置 `DATABASE_URL` 时才回退到 JSON 文件。

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

浏览器打开 `http://127.0.0.1:5173`，从左侧进入唯一的“知识库”。API 默认监听 `http://127.0.0.1:8787`。网页先启动时会自动重试 API 连接，连接成功后“立即同步”和“上传资料”自动恢复可用。上传 ZIP 时可指定目标目录；压缩包内的 Markdown/TXT 会进入索引，图片作为本地附件保存并用于安全预览，其他类型会跳过。

数据库连接写在不提交 Git 的 `.env.local` 中，可参考 `.env.example`。数据库需预先存在，表结构由 API 自动创建：

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

测试覆盖重复上传短路、局部 Chunk 复用、系统默认目录落盘、不可变原文快照、失败保留旧索引、固定版本证据和配置重建。

## 接口摘要

- `POST /api/projects`
- `POST /api/default-knowledge-base`
- `GET /api/local-model/status`
- `POST /api/local-model/start`
- `POST /api/local-model/stop`
- `GET /api/knowledge-bases/:id/overview`
- `GET|PUT /api/knowledge-bases/:id/config`
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
