# SmartHub 前端原型

根据 `需求文档/需求文档.md` 搭建的 AI 测试平台前端原型，当前使用模拟数据展示信息架构与页面布局。

平台采用单项目模型：项目空间内的数据按版本隔离，知识库和系统管理为全局能力，不随版本切换。

## 运行

```powershell
$ErrorActionPreference = 'Stop'
npm install
npm run dev
```

浏览器打开终端显示的本地地址（默认 `http://127.0.0.1:5173`）。

## 已包含模块

- 工作台
- 需求分析与上下文 AI 助手
- 知识库（文档、技术方案与知识资产管理）
- 测试设计与覆盖矩阵
- 测试执行
- 报告与诊断
- 系统管理

## 构建

```powershell
$ErrorActionPreference = 'Stop'
npm run build
```
