import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('需求评审左侧不展示固定需求输入目录选择器', () => {
  const source = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /需求输入目录|rr-directory-picker|knowledgeDirectoryOptions|setWorkspaceDirectoryPath/u)
  assert.match(source, /const workspaceDirectoryPath = projectVersion \? requirementWorkspaceDirectory\(projectVersion\.name\) : ''/u)
  assert.match(source, /当前版本暂无可分析文档/u)
})
