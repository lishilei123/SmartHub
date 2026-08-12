import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('需求评审左侧不展示固定需求输入目录选择器', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const analysisSource = readFileSync(new URL('../src/RequirementAnalysisPageV2.tsx', import.meta.url), 'utf8')
  const source = `${pageSource}\n${analysisSource}`

  assert.doesNotMatch(source, /需求输入目录|rr-directory-picker|knowledgeDirectoryOptions|setWorkspaceDirectoryPath/u)
  assert.match(pageSource, /const workspaceDirectoryPath = projectVersion \? requirementWorkspaceDirectory\(projectVersion\.name\) : ''/u)
  assert.match(analysisSource, /requirementDocuments\.map/u)
})

test('需求分析页面只呈现单 Agent 运行与统一结果 Artifact', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const analysisSource = readFileSync(new URL('../src/RequirementAnalysisPageV2.tsx', import.meta.url), 'utf8')
  const source = `${pageSource}\n${analysisSource}`
  assert.match(source, /RequirementAnalysisAgent 正在分析并自检/u)
  assert.match(source, /Requirement Analysis Report/u)
  assert.match(source, /result\.testFocus/u)
  assert.doesNotMatch(source, /retryAnalysis\('review_only'\)|两个 Agent 使用独立会话/u)
})

test('Workspace 统一上传入口位于固定底栏且顶部不再渲染重复操作按钮', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/requirement-review-layout.css', import.meta.url), 'utf8')

  assert.match(pageSource, /const footer = root\.querySelector<HTMLElement>\('\.rav2-workspace > footer'\)/u)
  assert.match(pageSource, /workspaceFooter && createPortal\(<div className="requirement-workspace-upload-actions">/u)
  assert.match(pageSource, /\{busy \? '处理中…' : '上传需求文档'\}/u)
  assert.match(pageSource, /accept="\.md,\.txt,\.zip,text\/markdown,text\/plain,application\/zip"/u)
  assert.match(pageSource, /uploadKnowledgeArchive\(knowledgeBaseId, file, workspaceDirectoryPath, 'requirement'\)/u)
  assert.doesNotMatch(pageSource, /workspaceHeader|requirement-workspace-inline-actions|archiveInputRef|>导入 ZIP</u)
  assert.match(layoutSource, /\.requirement-review-v2-shell \{[\s\S]*?flex: 1;[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/u)
  assert.match(layoutSource, /\.requirement-workspace-upload-actions \{[\s\S]*?order: -1;/u)
})
