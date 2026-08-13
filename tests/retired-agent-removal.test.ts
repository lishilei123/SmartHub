import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import { JsonStore } from '../server/infrastructure/store.js'

test('源码配置只保留五个正式 Agent 并移除旧拆分 Agent', async () => {
  const agents = JSON.parse(await readFile(new URL('../server/agent/agents-config.json', import.meta.url), 'utf8')) as { agents: Record<string, unknown> }
  const tools = JSON.parse(await readFile(new URL('../server/tools/built-in-tools-config.json', import.meta.url), 'utf8')) as { tools: Record<string, unknown> }
  const runtime = await readFile(new URL('../server/agent/pi-agent-runtime.ts', import.meta.url), 'utf8')
  assert.equal('requirement-analysis' in agents.agents, true)
  assert.equal('requirement-point-extraction' in agents.agents, false)
  assert.equal('requirement-review' in agents.agents, false)
  assert.equal('technical-solution-extraction' in agents.agents, false)
  assert.equal('technical-solution-review' in agents.agents, false)
  assert.equal('test-design' in agents.agents, true)
  assert.equal('test-script' in agents.agents, true)
  assert.equal('failure-analysis' in agents.agents, true)
  assert.equal('script-repair' in agents.agents, true)
  assert.equal('requirement-analysis.submit_result' in tools.tools, true)
  assert.equal('test_script.submit_result' in tools.tools, true)
  assert.equal('failure_analysis.submit_result' in tools.tools, true)
  assert.equal('script_repair.submit_result' in tools.tools, true)
  assert.equal('requirement-points.submit_result' in tools.tools, false)
  assert.equal('review.submit_result' in tools.tools, false)
  assert.equal('technical_solution_points.submit_result' in tools.tools, false)
  assert.equal('technical_solution_review.submit_result' in tools.tools, false)
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
      { id: 'technical-points-tool', key: 'technical_solution_points.submit_result' },
      { id: 'technical-review-tool', key: 'technical_solution_review.submit_result' },
      { id: 'current-tool', key: 'requirement-analysis.submit_result' },
    ],
    agentConfigurationDrafts: [{ scene: 'requirement_analysis', agents: { reviewQa: { revision: 3 }, requirementPointExtraction: { revision: 5 }, requirementReview: { revision: 4 }, technicalSolutionExtraction: { revision: 2 }, technicalSolutionReview: { revision: 2 }, requirementAnalysis: { revision: 1 } } }],
    agentConfigurationVersions: [
      { id: 'review-qa-v3', agentKey: 'reviewQa', agentDefinition: { agentKey: 'review-qa' } },
      { id: 'requirement-points-v5', agentKey: 'requirementPointExtraction', agentDefinition: { agentKey: 'requirement-point-extraction' } },
      { id: 'requirement-review-v4', agentKey: 'requirementReview', agentDefinition: { agentKey: 'requirement-review' } },
      { id: 'technical-extraction-v2', agentKey: 'technicalSolutionExtraction', agentDefinition: { agentKey: 'technical-solution-extraction' } },
      { id: 'technical-review-v2', agentKey: 'technicalSolutionReview', agentDefinition: { agentKey: 'technical-solution-review' } },
      { id: 'requirement-analysis-v1', agentKey: 'requirementAnalysis', agentDefinition: { agentKey: 'requirement-analysis' } },
    ],
    reviewRuns: [], findingActions: [], reviewQaSessions: [{ id: 'session-1' }], reviewQaTurns: [{ id: 'turn-1' }], toolApprovals: [],
    technicalSolutionReviews: [{ id: 'technical-review' }], technicalSolutionRuns: [{ id: 'technical-run' }], technicalSolutionFindingActions: [{ id: 'technical-action' }],
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
    assert.equal('technicalSolutionExtraction' in agents, false)
    assert.equal('technicalSolutionReview' in agents, false)
    assert.equal('technicalSolutionReviews' in persisted, false)
    assert.equal('technicalSolutionRuns' in persisted, false)
    assert.equal('technicalSolutionFindingActions' in persisted, false)
    assert.deepEqual((persisted.agentConfigurationVersions as Array<{ id: string }>).map(item => item.id), ['requirement-analysis-v1'])
    assert.deepEqual((persisted.aiResources as Array<{ key: string }>).map(item => item.key), ['requirement-analysis.submit_result'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('旧 JSON 聚合草稿在首次场景写入时拆分为三个独立 scene', async () => {
  const store = new JsonStore(null)
  await store.load()
  await new AiResourceService(store).list()
  const service = new AgentConfigurationService(store)
  const requirement = await service.get('requirement_analysis')
  const design = await service.get('test_design')
  const execution = await service.get('test_execution')
  await store.transaction(state => {
    state.agentConfigurationDrafts = [{
      scene: 'requirement_analysis',
      agents: {
        requirementAnalysis: requirement.agents.requirementAnalysis!.draft,
        testDesign: design.agents.testDesign!.draft,
        testScript: execution.agents.testScript!.draft,
        failureAnalysis: execution.agents.failureAnalysis!.draft,
        scriptRepair: execution.agents.scriptRepair!.draft,
      },
    }]
  })

  const testScript = execution.agents.testScript!.draft
  await service.save('test_execution', {
    agentKey: 'testScript',
    revision: testScript.revision,
    routing: testScript.routing,
    definition: testScript.definition,
  })

  const drafts = store.read().agentConfigurationDrafts
  assert.deepEqual(drafts.map(draft => draft.scene), [
    'requirement_analysis',
    'test_design',
    'test_execution',
  ])
  assert.deepEqual(Object.keys(drafts[0].agents), ['requirementAnalysis'])
  assert.deepEqual(Object.keys(drafts[1].agents), ['testDesign'])
  assert.deepEqual(Object.keys(drafts[2].agents), [
    'testScript',
    'failureAnalysis',
    'scriptRepair',
  ])
})

test('PostgreSQL 迁移删除已退役 Agent 的历史配置与工具资源', async () => {
  const source = await readFile(new URL('../server/infrastructure/migrations.ts', import.meta.url), 'utf8')
  assert.match(source, /name: 'remove-review-qa-agent-and-history'/u)
  assert.match(source, /DROP TABLE IF EXISTS smarthub\.review_qa_turns/u)
  assert.match(source, /name: 'remove-legacy-requirement-agents-and-history'/u)
  assert.match(source, /agent_key IN \('requirementPointExtraction', 'requirementReview'\)/u)
  assert.match(source, /resource_key IN \('requirement-points\.submit_result', 'review\.submit_result'\)/u)
  assert.match(source, /name: 'retire-technical-solution-review'/u)
  assert.match(source, /DROP TABLE IF EXISTS smarthub\.technical_solution_reviews/u)
  assert.match(source, /technicalSolutionExtraction/u)
  assert.match(source, /technical_solution_review\.submit_result/u)
})

test('PostgreSQL migration 27 将五 Agent 草稿拆分到三个 scene', async () => {
  const source = await readFile(new URL('../server/infrastructure/migrations.ts', import.meta.url), 'utf8')
  const migration = source.slice(source.indexOf("version: 27"), source.indexOf("version: 28"))

  assert.match(migration, /'test_design'.*'testDesign'/su)
  assert.match(migration, /'test_execution'.*'testScript'.*'failureAnalysis'.*'scriptRepair'/su)
  assert.match(migration, /UPDATE smarthub\.agent_configuration_drafts.*'requirement_analysis'.*'requirementAnalysis'/su)
  assert.doesNotMatch(migration, /version:\s*29/u)
})
