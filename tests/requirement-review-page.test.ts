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

test('需求分析页面由单 Agent 分阶段执行并只在发布门禁后展示最终产物', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const analysisSource = readFileSync(new URL('../src/RequirementAnalysisPageV2.tsx', import.meta.url), 'utf8')
  const source = `${pageSource}\n${analysisSource}`
  assert.match(source, /RequirementAnalysisAgent 正在分析并自检/u)
  assert.match(source, /分析期候选不等于最终产物/u)
  assert.match(source, /requirements\.json/u)
  assert.match(source, /TestDesignAgent 主需求输入/u)
  assert.match(source, /generateRequirementRepairDraft/u)
  assert.match(source, /verifyRequirementRepairDraft/u)
  assert.match(source, /publishRequirementRelease/u)
  assert.doesNotMatch(source, /parseFixDraft|replaceExactlyOnce|uploadKnowledgeFile\(knowledgeBaseId, new File\(\[content\]/u)
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

test('Workspace 每份需求文档提供受控删除入口并复用资产删除闭环', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const analysisSource = readFileSync(new URL('../src/RequirementAnalysisPageV2.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/requirement-review-layout.css', import.meta.url), 'utf8')

  assert.match(analysisSource, /onDeleteRequirementDocument\?: \(document: KnowledgeDocument\) => void/u)
  assert.match(analysisSource, /className="rav2-document-delete"/u)
  assert.match(analysisSource, /aria-label=\{`删除需求文档 \$\{document\.title \|\| document\.name\}`\}/u)
  assert.match(analysisSource, /disabled=\{!canDeleteRequirementDocument\}/u)
  assert.match(analysisSource, /onClick=\{\(\) => onDeleteRequirementDocument\(document\)\}/u)
  assert.match(pageSource, /onDeleteRequirementDocument=\{document => void removeDocument\(document\)\}/u)
  assert.match(pageSource, /window\.confirm\(`确认删除需求文档“\$\{document\.name\}”吗？/u)
  assert.match(pageSource, /deleteKnowledgeAsset\(document\.id\)/u)
  assert.match(pageSource, /await ensureTasksCompleted\(\[removed\.task\.id\]\)/u)
  assert.match(pageSource, /await refreshKnowledge\(\)/u)
  assert.match(layoutSource, /\.rav2-docs \.rav2-document-delete:hover:not\(:disabled\)/u)
})

test('Workspace 上传展示服务端任务驱动的汇总进度与完成失败状态', () => {
  const pageSource = readFileSync(new URL('../src/RequirementReviewPage.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/requirement-review-layout.css', import.meta.url), 'utf8')

  assert.match(pageSource, /type UploadProgress = \{/u)
  assert.match(pageSource, /setUploadProgress\(\{ stage: 'reading', percent: 2/u)
  assert.match(pageSource, /waitForTaskResults\(taskIds, \{ onProgress: progress => setUploadProgress/u)
  assert.match(pageSource, /progress\.percent \* \.7/u)
  assert.match(pageSource, /taskStepLabel\(progress\.currentStep\)/u)
  assert.match(pageSource, /stage: 'completed', percent: 100/u)
  assert.match(pageSource, /stage: 'failed', percent: current\?\.percent \?\? 0/u)
  assert.match(pageSource, /className=\{`requirement-upload-progress \$\{uploadProgress\.stage\}`\}/u)
  assert.match(pageSource, /<progress max="100" value=\{uploadProgress\.percent\} \/>/u)
  assert.match(pageSource, /role="status" aria-live="polite"/u)
  assert.match(layoutSource, /\.requirement-upload-progress progress \{/u)
  assert.match(layoutSource, /\.requirement-upload-progress\.completed/u)
  assert.match(layoutSource, /\.requirement-upload-progress\.failed/u)
})

test('Pi Agent 只展示统一需求分析执行记录且不再提供独立评审问答入口', () => {
  const analysisSource = readFileSync(new URL('../src/RequirementAnalysisPageV2.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(new URL('../src/requirement-review-layout.css', import.meta.url), 'utf8')

  assert.match(analysisSource, /<AgentConversation run=\{selectedRun\}/u)
  assert.match(analysisSource, /function AgentRunEvent/u)
  assert.match(analysisSource, /event\.toolArguments/u)
  assert.match(analysisSource, /event\.toolResult/u)
  assert.match(analysisSource, /event\.usage/u)
  assert.match(analysisSource, /event\.stopReason/u)
  assert.doesNotMatch(analysisSource, /ReviewQa|评审问答|askRequirementReviewQuestion|loadReviewQuestionHistory|rav2-chat-composer/u)
  assert.doesNotMatch(analysisSource, /\.slice\(-60\)|content\.slice\(0, 360\)/u)
  assert.match(layoutSource, /\.rav2-conversation-scroll \{/u)
  assert.match(layoutSource, /\.rav2-run-tool details/u)
})
