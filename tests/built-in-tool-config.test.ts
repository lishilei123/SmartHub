import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInToolBindingToken } from '../server/application/ai-resource-hash.js'
import { BuiltInToolConfigResolver, defaultBuiltInToolConfig, defaultBuiltInToolConfigResolver, validateBuiltInToolConfig } from '../server/tools/built-in-tool-config.js'
import { ToolRegistry } from '../server/tools/registry.js'

const cloneConfig = () => structuredClone(defaultBuiltInToolConfig)

test('checked-in built-in Tool config excludes retired requirement repair submissions', () => {
  assert.equal(defaultBuiltInToolConfigResolver.keys().length, 19)
  assert.equal(defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).length, 18)
  assert.ok(defaultBuiltInToolConfigResolver.keys().every(key => !key.startsWith('skill.')))
  assert.equal(defaultBuiltInToolConfigResolver.toToolResource('knowledge.search').source, 'builtin')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.read_file').piName, 'read')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.list_directory').piName, 'ls')
  const listDirectory = defaultBuiltInToolConfigResolver.toDescriptor('workspace.list_directory').parameters as unknown as {
    properties: { path: { minLength: number; description: string } }
  }
  assert.equal(listDirectory.properties.path.minLength, 0)
  assert.match(listDirectory.properties.path.description, /空字符串/u)
  for (const toolId of ['workspace.grep_files', 'workspace.find_files']) {
    const searchTool = defaultBuiltInToolConfigResolver.toDescriptor(toolId).parameters as unknown as {
      properties: { path: { minLength: number; description: string } }
    }
    assert.equal(searchTool.properties.path.minLength, 0)
    assert.match(searchTool.properties.path.description, /空字符串/u)
  }
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('test_design_cases.submit_result').piName, 'test_design_cases_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('requirement-analysis.submit_result').piName, 'requirement_analysis_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('execution_implementation.submit_result').piName, 'execution_implementation_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('failure_analysis.submit_result').piName, 'failure_analysis_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('browser.snapshot').piName, 'browser_snapshot')
  assert.equal(defaultBuiltInToolConfigResolver.has('browser.evaluate'), false)
  const reviewer = defaultBuiltInToolConfigResolver.toDescriptor('reviewer.submit_result').parameters as unknown as {
    properties: { reviewerType: { enum: string[] } }
  }
  assert.deepEqual(reviewer.properties.reviewerType.enum, ['requirement', 'coverage'])
})

test('Requirement Analysis 精简提交 Schema 会发布新的 Tool 绑定令牌', () => {
  assert.equal(
    builtInToolBindingToken('requirement-analysis.submit_result'),
    'requirement-analysis.submit_result@1.4.0#b79ba39bc155c12bacd53c14fc624f5df85becf2928e3075c48e6ad0ce2de6eb',
  )
})

test('测试执行候选工具只向 Agent 暴露最小智能结果', () => {
  const implementation = defaultBuiltInToolConfigResolver.toDescriptor('execution_implementation.submit_result').parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { files: { maxItems: number; items: { properties: { content: { maxLength: number } } } } }
  }
  const diagnosis = defaultBuiltInToolConfigResolver.toDescriptor('failure_analysis.submit_result').parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { evidence: { maxLength: number }; category: { enum: string[] } }
  }
  assert.equal(implementation.additionalProperties, false)
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('execution_implementation.submit_result').version, '1.0.0')
  assert.deepEqual(Object.keys(implementation.properties).sort(), ['entryFile', 'files', 'summary'])
  assert.deepEqual(implementation.required, ['entryFile', 'files'])
  assert.equal(implementation.properties.files.maxItems, 16)
  assert.equal(implementation.properties.files.items.properties.content.maxLength, 524_288)
  assert.equal(diagnosis.additionalProperties, false)
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('failure_analysis.submit_result').version, '2.0.0')
  assert.deepEqual(Object.keys(diagnosis.properties).sort(), ['category', 'evidence', 'reason'])
  assert.deepEqual(diagnosis.required, ['category', 'reason', 'evidence'])
  assert.equal(diagnosis.properties.evidence.maxLength, 4_000)
  assert.deepEqual(diagnosis.properties.category.enum, ['product_defect', 'script_defect', 'selector_changed', 'environment_defect', 'test_data_defect', 'flaky', 'assertion_mismatch', 'timeout', 'unknown'])
})

test('resolver copies outputs and descriptors register through the governed registry', () => {
  const first = defaultBuiltInToolConfigResolver.get('knowledge.search')
  first.parameters.properties = {}
  assert.ok('query' in (defaultBuiltInToolConfigResolver.get('knowledge.search').parameters.properties as Record<string, unknown>))

  const registry = new ToolRegistry()
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('knowledge.search'), async () => ({ data: {} }))
  registry.register(defaultBuiltInToolConfigResolver.toDescriptor('knowledge.read_chunk'), async () => ({ data: {} }))
  assert.deepEqual(registry.descriptors().map(item => item.id), ['knowledge.search', 'knowledge.read_chunk'])
})

test('测试用例提交工具向模型声明 Requirement 直接追溯字段', () => {
  const descriptor = defaultBuiltInToolConfigResolver.toDescriptor('test_design_cases.submit_result')
  const schema = descriptor.parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { schemaVersion: { const: string }; cases: { minItems?: number; items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } } }
  }
  assert.equal(descriptor.version, '4.0.0')
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.schemaVersion.const, 'test-case-design/v3')
  assert.deepEqual(Object.keys(schema.properties).sort(), ['cases', 'schemaVersion'])
  assert.ok(schema.required.includes('cases'))
  assert.equal(schema.properties.cases.minItems, undefined)
  assert.equal(schema.properties.cases.items.additionalProperties, false)
  assert.ok(schema.properties.cases.items.required.includes('ref'))
  assert.ok(schema.properties.cases.items.required.includes('requirementRefs'))
})

test('测试用例提交工具声明闭合的扁平 TestCase v3', () => {
  const schema = defaultBuiltInToolConfigResolver.toDescriptor('test_design_cases.submit_result').parameters as any
  const caseSchema = schema.properties.cases.items
  assert.equal(caseSchema.additionalProperties, false)
  assert.deepEqual(caseSchema.required, ['ref', 'schemaVersion', 'title', 'dimension', 'priority', 'requirementRefs', 'executionMethods', 'preconditions', 'steps', 'expectedResults'])
  assert.deepEqual(Object.keys(caseSchema.properties).sort(), [...caseSchema.required].sort())
  assert.equal(caseSchema.properties.schemaVersion.const, 'test-case/v3')
  assert.equal(caseSchema.properties.requirementRefs.minItems, undefined)
  assert.equal(caseSchema.properties.requirementRefs.uniqueItems, true)
  assert.equal(caseSchema.properties.executionMethods.uniqueItems, true)
  assert.deepEqual(caseSchema.properties.executionMethods.items.enum, ['ui', 'api'])
})

test('测试设计修复工具只声明 v3 patch 字段', () => {
  const descriptor = defaultBuiltInToolConfigResolver.toDescriptor('test_design_repair.submit_result')
  const schema = descriptor.parameters as any
  assert.equal(descriptor.version, '3.0.0')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['schemaVersion', 'baseCandidateSha256', 'upsertCases', 'removeCaseRefs'])
  assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort())
  assert.equal(schema.properties.schemaVersion.const, 'test-design-repair/v3')
  assert.equal(schema.properties.upsertCases.items.properties.schemaVersion.const, 'test-case/v3')
})

test('configuration validation rejects unsafe paths, unknown handlers, duplicate Pi names, and privileged variants', () => {
  const unsafePath = cloneConfig()
  unsafePath.tools['knowledge.search'].sourcePath = 'server/tools/../secret.ts'
  assert.throws(() => validateBuiltInToolConfig(unsafePath), /sourcePath/u)

  const unknownHandler = cloneConfig()
  unknownHandler.tools['knowledge.search'].handlerKey = 'handler.from.json'
  assert.throws(() => validateBuiltInToolConfig(unknownHandler), /handler/u)

  const duplicatePiName = cloneConfig()
  duplicatePiName.tools['knowledge.read_chunk'].piName = duplicatePiName.tools['knowledge.search'].piName
  assert.throws(() => validateBuiltInToolConfig(duplicatePiName), /piName/u)

  const privilegedVariant = cloneConfig()
  privilegedVariant.tools['knowledge.search'].variants = {
    unsafe: {
      ...privilegedVariant.tools['knowledge.search'],
      version: '2.0.0',
      label: 'unsafe',
      description: 'unsafe',
      parameters: privilegedVariant.tools['knowledge.search'].parameters,
      piName: 'other_name',
    },
  }
  assert.throws(() => validateBuiltInToolConfig(privilegedVariant), /不允许/u)
})

test('JSON Schema conversion preserves required fields, bounds, enums, consts, descriptions, and closed objects', () => {
  const config = cloneConfig()
  config.tools['knowledge.search'].parameters = {
    type: 'object',
    properties: {
      requiredText: { type: 'string', minLength: 1, maxLength: 5, description: 'required text' },
      optionalTags: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ['a', 'b'] } },
      fixed: { const: 'fixed-value' },
    },
    required: ['requiredText', 'fixed'],
    additionalProperties: false,
  }
  const schema = new BuiltInToolConfigResolver(validateBuiltInToolConfig(config)).toDescriptor('knowledge.search').parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: {
      requiredText: { minLength: number; maxLength: number; description: string }
      optionalTags: { minItems: number; maxItems: number; uniqueItems: boolean; items: { enum: string[] } }
      fixed: { const: string }
    }
  }
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required.sort(), ['fixed', 'requiredText'])
  assert.deepEqual(schema.properties.requiredText, { type: 'string', minLength: 1, maxLength: 5, description: 'required text' })
  assert.equal(schema.properties.optionalTags.minItems, 1)
  assert.equal(schema.properties.optionalTags.maxItems, 2)
  assert.equal(schema.properties.optionalTags.uniqueItems, true)
  assert.equal(schema.properties.fixed.const, 'fixed-value')
})

test('built-in binding tokens change when descriptor configuration changes', () => {
  const changed = cloneConfig()
  changed.tools['knowledge.search'].description = 'changed descriptor'
  const resolver = new BuiltInToolConfigResolver(validateBuiltInToolConfig(changed))
  assert.notEqual(builtInToolBindingToken('knowledge.search'), builtInToolBindingToken('knowledge.search', resolver))
})
