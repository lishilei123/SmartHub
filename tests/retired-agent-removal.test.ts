import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JsonStore } from '../server/infrastructure/store.js'

test('需求分析源码配置只保留统一 Agent 与统一提交工具', async () => {
  const agents = JSON.parse(await readFile(new URL('../server/agent/agents-config.json', import.meta.url), 'utf8')) as { agents: Record<string, unknown> }
  const tools = JSON.parse(await readFile(new URL('../server/tools/built-in-tools-config.json', import.meta.url), 'utf8')) as { tools: Record<string, unknown> }
  const runtime = await readFile(new URL('../server/agent/pi-agent-runtime.ts', import.meta.url), 'utf8')
  assert.equal('requirement-analysis' in agents.agents, true)
  assert.equal('requirement-point-extraction' in agents.agents, false)
  assert.equal('requirement-review' in agents.agents, false)
  assert.equal('requirement-analysis.submit_result' in tools.tools, true)
  assert.equal('requirement-points.submit_result' in tools.tools, false)
  assert.equal('review.submit_result' in tools.tools, false)
  assert.doesNotMatch(runtime, /RequirementPointExtractionAgent|RequirementReviewAgent|createRequirementReviewToolRegistry/u)
})

test('JSON Store 加载时物理删除已退役 Agent、配置快照和工具资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smarthub-remove-retired-agents-'))
  const file = join(directory, 'state.json')
  const legacyState = {
    projects: [], projectVersions: [], projectVersionRequirementBindings: [], knowledgeBases: [], directories: [], configs: [], assets: [], versions: [], indexes: [], tasks: [], modelSources: [],
    aiResources: [
      { id: 'review-answer-tool', key: 'review.answer_submit' },
      { id: 'requirement-points-tool', key: 'requirement-points.submit_result' },
      { id: 'requirement-review-tool', key: 'review.submit_result' },
      { id: 'current-tool', key: 'requirement-analysis.submit_result' },
    ],
    agentConfigurationDrafts: [{ scene: 'requirement_analysis', agents: { reviewQa: { revision: 3 }, requirementPointExtraction: { revision: 5 }, requirementReview: { revision: 4 }, requirementAnalysis: { revision: 1 } } }],
    agentConfigurationVersions: [
      { id: 'review-qa-v3', agentKey: 'reviewQa', agentDefinition: { agentKey: 'review-qa' } },
      { id: 'requirement-points-v5', agentKey: 'requirementPointExtraction', agentDefinition: { agentKey: 'requirement-point-extraction' } },
      { id: 'requirement-review-v4', agentKey: 'requirementReview', agentDefinition: { agentKey: 'requirement-review' } },
      { id: 'requirement-analysis-v1', agentKey: 'requirementAnalysis', agentDefinition: { agentKey: 'requirement-analysis' } },
    ],
    reviewRuns: [], findingActions: [], reviewQaSessions: [{ id: 'session-1' }], reviewQaTurns: [{ id: 'turn-1' }], toolApprovals: [],
    technicalSolutionReviews: [], technicalSolutionRuns: [], technicalSolutionFindingActions: [],
  }
  await writeFile(file, JSON.stringify(legacyState), 'utf8')
  const store = new JsonStore(file)
  try {
    await store.load()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    assert.equal('reviewQaSessions' in persisted, false)
    assert.equal('reviewQaTurns' in persisted, false)
    const agents = (persisted.agentConfigurationDrafts as Array<{ agents: Record<string, unknown> }>)[0].agents
    assert.equal('reviewQa' in agents, false)
    assert.equal('requirementPointExtraction' in agents, false)
    assert.equal('requirementReview' in agents, false)
    assert.deepEqual((persisted.agentConfigurationVersions as Array<{ id: string }>).map(item => item.id), ['requirement-analysis-v1'])
    assert.deepEqual((persisted.aiResources as Array<{ key: string }>).map(item => item.key), ['requirement-analysis.submit_result'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('PostgreSQL 迁移删除已退役 Agent 的历史配置与工具资源', async () => {
  const source = await readFile(new URL('../server/infrastructure/migrations.ts', import.meta.url), 'utf8')
  assert.match(source, /name: 'remove-review-qa-agent-and-history'/u)
  assert.match(source, /DROP TABLE IF EXISTS smarthub\.review_qa_turns/u)
  assert.match(source, /name: 'remove-legacy-requirement-agents-and-history'/u)
  assert.match(source, /agent_key IN \('requirementPointExtraction', 'requirementReview'\)/u)
  assert.match(source, /resource_key IN \('requirement-points\.submit_result', 'review\.submit_result'\)/u)
})
