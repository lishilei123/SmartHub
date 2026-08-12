import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('需求评审左侧不展示固定需求输入目录选择器', () => {
  const source = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /需求输入目录|rr-directory-picker|knowledgeDirectoryOptions|setWorkspaceDirectoryPath/u)
  assert.match(source, /const workspaceDirectoryPath = projectVersion \? requirementWorkspaceDirectory\(projectVersion\.name\) : ''/u)
  assert.match(source, /当前版本暂无可分析文档/u)
})

test('需求分析页面只呈现单 Agent 运行与统一结果 Artifact', () => {
  const source = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  assert.match(source, /RequirementAnalysisAgent 正在分析并自检/u)
  assert.match(source, /Requirement Analysis Document/u)
  assert.match(source, /result\.testFocus/u)
  assert.doesNotMatch(source, /retryAnalysis\('review_only'\)|两个 Agent 使用独立会话/u)
})
