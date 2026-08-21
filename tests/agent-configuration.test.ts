import assert from 'node:assert/strict'
import test from 'node:test'
import { PiTestDesignRuntimeAdapter } from '../server/agent/pi-test-design-runtime.js'
import {
  PiTestExecutionRuntimeAdapter,
  TEST_EXECUTION_STAGE_BINDINGS,
  type TestExecutionAgentRuntimeInput,
} from '../server/agent/pi-test-execution-runtime.js'
import { AgentConfigurationService } from '../server/application/agent-configuration-service.js'
import { AiResourceService } from '../server/application/ai-resource-service.js'
import type { AgentExecutionInput } from '../server/domain/agent-types.js'
import type { ExecutionRun, ExecutionTask } from '../server/domain/test-execution-types.js'
import { JsonStore } from '../server/infrastructure/store.js'
import { materializeRequiredAgentCapabilities } from '../src/agent-configuration-api.js'

async function fixture() {
  const store = new JsonStore(null)
  await store.load()
  await store.transaction(state => {
    state.modelSources.push({
      id: 'source-agent-config',
      name: 'Agent 配置测试来源',
      providerType: 'openai_compatible',
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      enabled: true,
      health: 'healthy',
      priority: 1,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
      models: [{
        id: 'model-agent-config',
        name: 'agent-model',
        displayName: 'Agent Model',
        contextWindow: 256_000,
        maxOutputTokens: 128_000,
        capabilities: ['tool_calling', 'reasoning'],
        enabled: true,
        health: 'healthy',
        qualityGate: { version: 'model-probe/v2', checkedAt: '2026-07-27T00:00:00.000Z', passed: true, sampleSha256: 'a'.repeat(64), inputCharacters: 8_000, checks: { connectivity: true, longContext: true, structuredSubmission: true, toolCalling: true } },
      }],
    })
  })
  await new AiResourceService(store).list()
  return { store, service: new AgentConfigurationService(store) }
}

test('统一 PlanningAgent 发布 Workspace、Knowledge、Skill 与全部提交协议快照', async () => {
  const { service } = await fixture()
  const initial = (await service.get('planning')).agents.planning!
  assert.deepEqual(initial.requiredToolIds, ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'knowledge.search', 'knowledge.read_chunk', 'requirement-analysis.submit_result', 'test_design_cases.submit_result', 'test_design_repair.submit_result'])
  assert.ok(initial.draft.definition.toolIds.includes('workspace.read_file'))
  assert.ok(initial.draft.definition.toolIds.includes('knowledge.search'))
  assert.ok(initial.draft.definition.skillKeys.includes('requirement.analysis'))
  assert.ok(initial.draft.definition.skillKeys.includes('test-case-design'))
  const saved = await service.save('planning', {
    agentKey: 'planning',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 12_288 },
    definition: initial.draft.definition,
  })
  const published = await service.publish('planning', { agentKey: 'planning', revision: saved.revision, publishedBy: '测试策划管理员' })
  assert.equal(published.agentDefinition.agentKey, 'planning')
  assert.equal(published.agentDefinition.resultSchemaVersion, 'planning/v1')
  assert.deepEqual(published.agentDefinition.skillBindings.map(binding => binding.skillKey), initial.draft.definition.skillKeys)
  assert.equal((await service.resolveActive('planning'))?.id, published.id)
})

test('PlanningAgent 草稿加载与前端发布 payload 会补齐新增的必需工具', async () => {
  const { store, service } = await fixture()
  const initialState = (await service.get('planning')).agents.planning!
  const firstSaved = await service.save('planning', {
    agentKey: 'planning',
    revision: initialState.draft.revision,
    routing: { ...initialState.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initialState.draft.definition,
  })
  const newlyRequiredTools = new Set(['test_design_repair.submit_result'])
  await store.transaction(state => {
    const stored = state.agentConfigurationDrafts.find(item => item.scene === 'planning')!.agents.planning!
    stored.definition.toolIds = stored.definition.toolIds.filter(toolId => !newlyRequiredTools.has(toolId))
  })

  const reloaded = (await service.get('planning')).agents.planning!
  assert.equal(reloaded.draft.revision, firstSaved.revision)
  assert.ok(reloaded.requiredToolIds.every(toolId => reloaded.draft.definition.toolIds.includes(toolId)))

  const staleBrowserDraft = structuredClone(reloaded.draft)
  staleBrowserDraft.definition.toolIds = staleBrowserDraft.definition.toolIds.filter(toolId => !newlyRequiredTools.has(toolId))
  const publishPayload = materializeRequiredAgentCapabilities(staleBrowserDraft, reloaded)
  assert.ok(reloaded.requiredToolIds.every(toolId => publishPayload.definition.toolIds.includes(toolId)))

  const migrated = await service.save('planning', { agentKey: 'planning', revision: publishPayload.revision, routing: publishPayload.routing, definition: publishPayload.definition })
  const published = await service.publish('planning', { agentKey: 'planning', revision: migrated.revision })
  assert.ok(reloaded.requiredToolIds.every(toolId => published.agentDefinition.toolIds.includes(toolId)))
})

test('统一 PlanningAgent 为需求分析和测试设计发布同一条不可变版本链', async () => {
  const { store, service } = await fixture()
  const planning = await service.get('planning')
  assert.deepEqual(Object.keys(planning.agents), ['planning'])
  assert.equal('requirementAnalysis' in planning.agents, false)
  assert.equal('testDesign' in planning.agents, false)
  const initial = planning.agents.planning!.draft
  const saved = await service.save('planning', { agentKey: 'planning', revision: initial.revision, routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, maxOutputTokens: 8_192 }, definition: initial.definition })
  const published = await service.publish('planning', { agentKey: 'planning', revision: saved.revision, publishedBy: '测试策划管理员' })
  assert.equal(published.scene, 'planning')
  assert.equal(published.agentDefinition.agentKey, 'planning')
  assert.equal(published.agentDefinition.modelScene, 'planning')

  const secondDraft = await service.save('planning', {
    agentKey: 'planning',
    revision: saved.revision,
    routing: saved.routing,
    definition: { ...saved.definition, systemPrompt: `${saved.definition.systemPrompt}\n第二版。` },
  })
  const second = await service.publish('planning', { agentKey: 'planning', revision: secondDraft.revision })
  const state = store.read()
  assert.equal(second.version, 2)
  assert.equal(state.agentConfigurationVersions.find(item => item.id === published.id)?.status, 'superseded')
  assert.doesNotMatch((await service.getVersion(published.id)).agentDefinition.systemPrompt, /第二版/)
})

test('Agent 配置读取使用窄查询而不加载完整状态快照', async () => {
  const store = new JsonStore(null)
  await store.load()
  store.snapshot = async () => { throw new Error('不应读取完整状态快照') }
  const service = new AgentConfigurationService(store)

  const planning = await service.get('planning')
  const testExecution = await service.get('test_execution')

  assert.equal(planning.scene, 'planning')
  assert.deepEqual(Object.keys(planning.agents), ['planning'])
  assert.equal(planning.agents.planning!.draft.revision, 0)
  assert.equal('requirementAnalysis' in planning.agents, false)
  assert.equal('testDesign' in planning.agents, false)
  assert.equal(testExecution.scene, 'test_execution')
  assert.deepEqual(Object.keys(testExecution.agents), ['testScript', 'failureAnalysis', 'scriptRepair'])
  assert.equal(testExecution.agents.testScript!.draft.revision, 0)
})

test('Agent 配置拒绝移除必需提交工具、过期 revision 和不可用模型', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get('planning')).agents.planning!.draft
  await assert.rejects(() => service.save('planning', {
    agentKey: 'planning',
    revision: 0,
    routing: initial.routing,
    definition: { ...initial.definition, toolIds: [] },
  }), /必须保留结果提交工具/)

  const saved = await service.save('planning', {
    agentKey: 'planning',
    revision: 0,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initial.definition,
  })
  await assert.rejects(() => service.save('planning', { agentKey: 'planning', revision: 0, routing: saved.routing, definition: saved.definition }), /已被其他操作更新/)
  await store.transaction(state => { state.modelSources[0].models[0].health = 'degraded' })
  await assert.rejects(() => service.publish('planning', { agentKey: 'planning', revision: saved.revision }), /尚未通过健康探测/)
})

test('测试设计始终冻结最新发布的 PlanningAgent 并保持 Runtime 就绪', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get('planning')).agents.planning!.draft
  const saved = await service.save('planning', {
    agentKey: 'planning',
    revision: initial.revision,
    routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initial.definition,
  })
  const first = await service.publish('planning', { agentKey: 'planning', revision: saved.revision })
  const nextDraft = await service.save('planning', {
    agentKey: 'planning',
    revision: saved.revision,
    routing: saved.routing,
    definition: { ...saved.definition, systemPrompt: `${saved.definition.systemPrompt}\n最新测试设计配置。` },
  })
  const latest = await service.publish('planning', { agentKey: 'planning', revision: nextDraft.revision })

  const runtime = new PiTestDesignRuntimeAdapter(store, null as never, service)
  const readiness = await runtime.readiness()
  const frozen = await runtime.freezeConfiguration()
  const planning = readiness.agents.find(item => item.agentKey === 'planning')

  assert.equal(planning?.ready, true)
  assert.equal(planning?.reason, undefined)
  assert.notEqual(frozen.configurationId, first.id)
  assert.equal(frozen.configurationId, latest.id)
  assert.equal(frozen.configurationVersion, latest.version)
  assert.equal(frozen.configurationSha256, latest.contentSha256)
})

test('三个测试执行 Agent 独立发布、精确能力就绪并冻结不同版本', async () => {
  const { store, service } = await fixture()
  const states = await service.get('test_execution')
  assert.deepEqual(Object.keys(states.agents), ['testScript', 'failureAnalysis', 'scriptRepair'])
  const expected = {
    testScript: {
      definitionKey: 'test-script',
      tools: ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'test_script.submit_result'],
      skill: 'test-script-generation',
    },
    failureAnalysis: {
      definitionKey: 'failure-analysis',
      tools: ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'failure_analysis.submit_result'],
      skill: 'failure-analysis',
    },
    scriptRepair: {
      definitionKey: 'script-repair',
      tools: ['workspace.read_file', 'workspace.grep_files', 'workspace.find_files', 'workspace.list_directory', 'script_repair.submit_result'],
      skill: 'script-repair',
    },
  } as const

  for (const [agentKey, contract] of Object.entries(expected) as Array<[keyof typeof expected, typeof expected[keyof typeof expected]]>) {
    const agent = states.agents[agentKey]!
    assert.deepEqual(agent.requiredToolIds, contract.tools)
    assert.deepEqual(agent.requiredSkillKeys, [contract.skill])
    assert.deepEqual(agent.requiredMcpServerKeys, [])
    await assert.rejects(() => service.save('test_execution', {
      agentKey,
      revision: agent.draft.revision,
      routing: agent.draft.routing,
      definition: { ...agent.draft.definition, toolIds: [...agent.draft.definition.toolIds, 'knowledge.search'] },
    }), /不允许额外工具/u)
    const saved = await service.save('test_execution', {
      agentKey,
      revision: agent.draft.revision,
      routing: { ...agent.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
      definition: agent.draft.definition,
    })
    const published = await service.publish('test_execution', { agentKey, revision: saved.revision })
    assert.equal(published.scene, 'test_execution')
    assert.equal(published.agentDefinition.agentKey, contract.definitionKey)
    assert.deepEqual(published.agentDefinition.toolIds, contract.tools)
    assert.deepEqual(published.agentDefinition.skillBindings.map(binding => binding.skillKey), [contract.skill])
    assert.deepEqual(published.agentDefinition.mcpBindings, [])
  }

  const runtime = new PiTestExecutionRuntimeAdapter(store, null as never, service)
  const readiness = await runtime.readiness()
  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.agents.map(agent => [agent.agentKey, agent.ready]), [
    ['test-script', true],
    ['failure-analysis', true],
    ['script-repair', true],
  ])
  const frozen = await runtime.freezeConfigurations()
  assert.equal(frozen.testScript.agentKey, 'test-script')
  assert.equal(frozen.failureAnalysis.agentKey, 'failure-analysis')
  assert.equal(frozen.scriptRepair.agentKey, 'script-repair')
  assert.equal(new Set(Object.values(frozen).map(snapshot => snapshot.configurationId)).size, 3)
  for (const snapshot of Object.values(frozen)) {
    assert.match(snapshot.snapshotSha256, /^[a-f0-9]{64}$/u)
    assert.equal(snapshot.model.baseUrlSha256.length, 64)
    assert.equal('apiKey' in snapshot.model, false)
    assert.equal('baseUrl' in snapshot.model, false)
  }
})

test('测试执行 runtime 按固定 stage 暴露自己的 Tool/Skill 并保留 supersede 前版本', async () => {
  const { store, service } = await fixture()
  const keys = ['testScript', 'failureAnalysis', 'scriptRepair'] as const
  for (const agentKey of keys) {
    const initial = (await service.get('test_execution')).agents[agentKey]!
    const saved = await service.save('test_execution', {
      agentKey,
      revision: initial.draft.revision,
      routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
      definition: initial.draft.definition,
    })
    await service.publish('test_execution', { agentKey, revision: saved.revision })
  }

  const captured: AgentExecutionInput[] = []
  const piRuntime = {
    execute: async (input: AgentExecutionInput) => {
      captured.push(input)
      return {
        candidate: { accepted: true },
        events: [],
        turns: 1,
        toolCalls: 1,
        toolErrors: 0,
        framework: { name: 'pi-agent-core' as const, version: 'test' },
      }
    },
  }
  const runtime = new PiTestExecutionRuntimeAdapter(store, piRuntime as never, service)
  const agents = await runtime.freezeConfigurations()
  const run = executionRunFixture(agents)
  const task = executionTaskFixture(run.id)
  const workspace = executionWorkspaceFixture(run)

  const supersededId = agents.testScript.configurationId
  const current = (await service.get('test_execution')).agents.testScript
  const changed = await service.save('test_execution', {
    agentKey: 'testScript',
    revision: current.draft.revision,
    routing: current.draft.routing,
    definition: { ...current.draft.definition, systemPrompt: `${current.draft.definition.systemPrompt}\n新版本。` },
  })
  const active = await service.publish('test_execution', { agentKey: 'testScript', revision: changed.revision })
  assert.notEqual(active.id, supersededId)

  for (const stage of Object.keys(TEST_EXECUTION_STAGE_BINDINGS) as Array<keyof typeof TEST_EXECUTION_STAGE_BINDINGS>) {
    const binding = TEST_EXECUTION_STAGE_BINDINGS[stage]
    await runtime.execute({
      stage,
      run,
      task,
      workspace,
      stageContext: stage === 'failure_diagnosis'
        ? { scriptRevisionId: 'revision-1', attemptIds: ['attempt-1', 'attempt-2'], artifactIds: ['artifact-1'] }
        : stage === 'script_repair'
          ? { parentScriptRevisionId: 'revision-1', diagnosisId: 'diagnosis-1', repairCount: 0 }
          : undefined,
      validateCandidate: async candidate => ({ valid: true, result: candidate, issues: [] }),
    }, new AbortController().signal)
    const input = captured.at(-1)!
    assert.equal(input.snapshot.agentDefinition.agentKey, binding.agentKey)
    assert.deepEqual(input.executionProfile?.allowedToolIds, [
      'workspace.read_file',
      'workspace.grep_files',
      'workspace.find_files',
      'workspace.list_directory',
      binding.submitToolId,
    ])
    assert.equal(input.executionProfile?.allowedToolIds.includes('knowledge.search'), false)
    assert.equal(input.executionProfile?.allowedToolIds.some(toolId => /runner|shell|ssh|database|http/u.test(toolId)), false)
  }
  assert.equal(captured[0].snapshot.agentDefinition.contentSha256, (await service.getVersion(supersededId)).agentDefinition.contentSha256)
})

test('测试执行 Agent 模型参数漂移会破坏 frozen snapshot 就绪契约', async () => {
  const { store, service } = await fixture()
  const initial = (await service.get('test_execution')).agents.testScript
  const saved = await service.save('test_execution', {
    agentKey: 'testScript',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: initial.draft.definition,
  })
  await service.publish('test_execution', { agentKey: 'testScript', revision: saved.revision })
  const runtime = new PiTestExecutionRuntimeAdapter(store, null as never, service)
  const readiness = await runtime.readiness()
  assert.equal(readiness.ready, false)
  assert.equal(readiness.agents.find(agent => agent.agentKey === 'test-script')?.ready, true)
  assert.equal(readiness.agents.find(agent => agent.agentKey === 'failure-analysis')?.ready, false)
})

test('Agent 最大输出 Token 不能超过配置的上下文窗口', async () => {
  const { service } = await fixture()
  const initial = (await service.get('planning')).agents.planning!.draft
  await assert.rejects(
    () => service.save('planning', {
      agentKey: 'planning',
      revision: initial.revision,
      routing: { ...initial.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' }, contextWindow: 128_000, maxOutputTokens: 262_144 },
      definition: initial.definition,
    }),
    /最大输出 Token 不能超过上下文窗口/u,
  )
})

function executionRunFixture(agents: ExecutionRun['agents']): ExecutionRun {
  return {
    id: 'execution-run-1',
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    handoff: {
      handoffId: 'handoff-1',
      handoffSha256: 'a'.repeat(64),
      projectId: 'project-1',
      projectVersionId: 'project-version-1',
      testCaseLibraryVersionId: 'library-1',
      testCaseLibraryVersionSha256: 'b'.repeat(64),
      mode: 'smoke',
      memberSnapshotSha256: 'c'.repeat(64),
    },
    environment: { environmentId: 'environment-1', name: '测试环境', baseUrl: 'https://test.example', targets: [{ protocol: 'https', host: 'test.example', port: 443 }], signature: 'environment-signature' },
    runner: { runnerVersion: '1.0.0', playwrightVersion: '1.57.0', imageReference: 'runner:test', imageDigest: 'sha256:runner' },
    agents,
    status: 'running',
    stateVersion: 1,
    idempotencyKey: 'idempotency-1',
    taskCount: 1,
    createdBy: 'tester',
    createdAt: '2026-08-13T00:00:00.000Z',
  }
}

function executionTaskFixture(runId: string): ExecutionTask {
  const caseContent = { schemaVersion: 'test-case/v3' as const, title: '状态检查', dimension: 'functional' as const, requirementRefs: ['point-1'], priority: 'P0' as const, preconditions: [], executionMethods: ['ui' as const], steps: ['打开状态页'], expectedResults: ['页面已就绪'] }
  const executionSpec = { schemaVersion: 'test-script-input/v1' as const, method: 'ui' as const, testCase: caseContent }
  return {
    id: 'task-1',
    runId,
    input: { sourceVersionId: 'library-1', ordinal: 0, dedupKey: 'case-1:1:ui', stage: 'smoke', caseId: 'case-1', caseRevision: 1, caseContent, caseContentSha256: 'd'.repeat(64), method: 'ui', dimension: 'functional', executionSpec, executionSpecSha256: 'e'.repeat(64), inputSha256: 'f'.repeat(64) },
    status: 'diagnosing',
    stateVersion: 1,
    runnerAttemptCount: 2,
    sameScriptRetryCount: 1,
    repairCount: 0,
    currentScriptRevisionId: 'revision-1',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:01:00.000Z',
  }
}

function executionWorkspaceFixture(run: ExecutionRun): TestExecutionAgentRuntimeInput['workspace'] {
  return {
    runId: run.id,
    projectId: run.projectId,
    projectName: '项目',
    projectVersionId: run.projectVersionId,
    projectVersionName: 'V1.0',
    knowledgeBaseId: 'knowledge-base-1',
    indexVersionId: 'index-1',
    assets: [],
    documentWorkspace: { mode: 'agent_directory', logicalPath: 'workspace', rootLogicalPath: 'workspace', activeBranchLogicalPath: 'workspace/branches/V1.0', branchLogicalPaths: ['workspace/branches/V1.0'], agentLogicalPath: 'workspace/agent_workspace/execution_agent', layoutVersion: 'workspace/v1', candidateAssetVersionIds: [] },
    workspaceFiles: [{ logicalPath: 'workspace/branches/V1.0/execution/run-1/task.json', contentSha256: '1'.repeat(64), content: '{"taskId":"task-1"}\n', displayName: 'task.json' }],
  }
}

test('Agent 配置可选择完整 Tool、MCP、Skill 并在发布版本中固定资源版本', async () => {
  const { store, service } = await fixture()
  await store.transaction(state => {
    state.aiResources.push({
      id: 'mcp-quality-review', kind: 'mcp', key: 'quality.mcp', name: '质量 MCP', description: '质量系统远程工具', version: '2.1.0', enabled: true, status: 'draft', builtIn: false,
      transport: 'streamable_http', endpoint: 'https://quality.example.com/mcp', authType: 'none', toolIds: ['quality.lookup'], createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
    })
    state.aiResources.push({
      id: 'tool-quality-lookup', kind: 'tool', key: 'quality.lookup', name: '质量查询', description: '查询质量规则', version: '3.0.0', enabled: true, status: 'draft', builtIn: false,
      source: 'mcp', risk: 'network_read', timeoutMs: 30_000, mcpServerId: 'mcp-quality-review', createdAt: '2026-07-27T00:00:00.000Z', updatedAt: '2026-07-27T00:00:00.000Z',
    })
    state.aiResources.push({
      id: 'skill-quality-review',
      kind: 'skill',
      key: 'quality.review',
      name: '质量复核',
      description: '复核边界与验收条件',
      version: '1.2.0',
      enabled: true,
      status: 'draft',
      builtIn: false,
      entrypoint: 'ai/skills/quality-review/SKILL.md',
      toolIds: ['quality.lookup'],
      tags: ['质量', '评审'],
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    })
  })
  const initial = (await service.get('planning')).agents.planning!
  assert.ok(initial.requiredToolIds.includes('test_design_cases.submit_result'))
  assert.deepEqual(initial.requiredSkillKeys, [])
  assert.deepEqual(initial.requiredMcpServerKeys, [])
  assert.ok(initial.draft.definition.skillKeys.includes('requirement.analysis'))
  assert.ok(initial.draft.definition.skillKeys.includes('test-case-design'))
  assert.deepEqual(initial.draft.definition.mcpServerKeys, [])

  await assert.rejects(() => service.save('planning', {
    agentKey: 'planning', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, skillKeys: [...initial.draft.definition.skillKeys, 'quality.review'] },
  }), /依赖未选择工具/u)
  await assert.rejects(() => service.save('planning', {
    agentKey: 'planning', revision: initial.draft.revision, routing: initial.draft.routing,
    definition: { ...initial.draft.definition, toolIds: [...initial.draft.definition.toolIds, 'quality.lookup'] },
  }), /必须同时选择其 MCP 服务/u)

  const saved = await service.save('planning', {
    agentKey: 'planning',
    revision: initial.draft.revision,
    routing: { ...initial.draft.routing, primaryModel: { sourceId: 'source-agent-config', modelId: 'model-agent-config' } },
    definition: { ...initial.draft.definition, skillKeys: [...initial.draft.definition.skillKeys, 'quality.review'], mcpServerKeys: ['quality.mcp'], toolIds: [...initial.draft.definition.toolIds, 'quality.lookup'] },
  })
  assert.ok(saved.definition.skillKeys.includes('quality.review'))
  assert.deepEqual(saved.definition.mcpServerKeys, ['quality.mcp'])
  assert.ok(saved.definition.toolIds.includes('quality.lookup'))
  const published = await service.publish('planning', { agentKey: 'planning', revision: saved.revision })
  const customSkillBinding = published.agentDefinition.skillBindings.find(item => item.skillKey === 'quality.review')
  assert.deepEqual(customSkillBinding && { skillKey: customSkillBinding.skillKey, version: customSkillBinding.version, enabled: customSkillBinding.enabled }, { skillKey: 'quality.review', version: '1.2.0', enabled: true })
  assert.match(customSkillBinding!.configurationHash, /^[a-f0-9]{64}$/u)
  assert.deepEqual(published.agentDefinition.mcpBindings.map(item => ({ serverKey: item.serverKey, version: item.version, toolIds: item.toolIds })), [
    { serverKey: 'quality.mcp', version: '2.1.0', toolIds: ['quality.lookup'] },
  ])
  assert.match(published.agentDefinition.mcpBindings[0].policyHash, /^[a-f0-9]{64}$/u)
  assert.ok(published.agentDefinition.toolIds.includes('quality.lookup'))
  await assert.rejects(() => new AiResourceService(store).delete('skill', 'skill-quality-review'), /仍被 Agent 草稿引用/)
  await assert.rejects(() => new AiResourceService(store).delete('mcp', 'mcp-quality-review'), /仍被工具引用/)
  await assert.rejects(() => new AiResourceService(store).delete('tool', 'tool-quality-lookup'), /仍被 Skill 引用/)

  await store.transaction(state => {
    const skill = state.aiResources.find(item => item.kind === 'skill' && item.key === 'quality.review')!
    skill.version = '2.0.0'
    skill.enabled = false
  })
  assert.equal((await service.getVersion(published.id)).agentDefinition.skillBindings.find(item => item.skillKey === 'quality.review')?.version, '1.2.0')
  await assert.rejects(() => service.save('planning', {
    agentKey: 'planning',
    revision: saved.revision,
    routing: saved.routing,
    definition: saved.definition,
  }), /包含未启用 Skill/)
  await assert.rejects(() => service.save('planning', {
    agentKey: 'planning',
    revision: saved.revision,
    routing: saved.routing,
    definition: { ...saved.definition, skillKeys: ['missing.skill'] },
  }), /包含未注册 Skill/)
})
