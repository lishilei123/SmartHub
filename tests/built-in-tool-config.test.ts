import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInToolBindingToken } from '../server/application/ai-resource-hash.js'
import { BuiltInToolConfigResolver, defaultBuiltInToolConfig, defaultBuiltInToolConfigResolver, validateBuiltInToolConfig } from '../server/tools/built-in-tool-config.js'
import { ToolRegistry } from '../server/tools/registry.js'

const cloneConfig = () => structuredClone(defaultBuiltInToolConfig)

test('checked-in built-in Tool config excludes retired requirement repair submissions', () => {
  assert.equal(defaultBuiltInToolConfigResolver.keys().length, 13)
  assert.equal(defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).length, 12)
  assert.ok(defaultBuiltInToolConfigResolver.keys().every(key => !key.startsWith('skill.')))
  assert.equal(defaultBuiltInToolConfigResolver.toToolResource('knowledge.search').source, 'builtin')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.read_file').piName, 'read')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.list_directory').piName, 'ls')
  const listDirectory = defaultBuiltInToolConfigResolver.toDescriptor('workspace.list_directory').parameters as unknown as {
    properties: { path: { minLength: number; description: string } }
  }
  assert.equal(listDirectory.properties.path.minLength, 0)
  assert.match(listDirectory.properties.path.description, /空字符串/u)
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('test_design_cases.submit_result').piName, 'test_design_cases_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('requirement-analysis.submit_result').piName, 'requirement_analysis_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('test_script.submit_result').piName, 'test_script_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('failure_analysis.submit_result').piName, 'failure_analysis_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('script_repair.submit_result').piName, 'script_repair_submit_result')
})

test('Requirement Analysis coverageTarget Schema 升级会发布新的 Tool 绑定令牌', () => {
  assert.equal(
    builtInToolBindingToken('requirement-analysis.submit_result'),
    'requirement-analysis.submit_result@1.3.0#e186573f01c63fffea1584cff29b8cd271919a8c7892289c419ccd47996bb4b5',
  )
})

test('测试执行候选工具使用闭合身份与服务端一致的大小边界', () => {
  const script = defaultBuiltInToolConfigResolver.toDescriptor('test_script.submit_result').parameters as unknown as {
    additionalProperties: boolean
    properties: { files: { maxItems: number; items: { properties: { content: { maxLength: number } } } } }
  }
  const diagnosis = defaultBuiltInToolConfigResolver.toDescriptor('failure_analysis.submit_result').parameters as unknown as {
    additionalProperties: boolean
    properties: { evidence: { maxItems: number }; category: { enum: string[] } }
  }
  const repair = defaultBuiltInToolConfigResolver.toDescriptor('script_repair.submit_result').parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { files: { items: { properties: { content: { maxLength: number } } } } }
  }
  assert.equal(script.additionalProperties, false)
  assert.equal(script.properties.files.maxItems, 1)
  assert.equal(script.properties.files.items.properties.content.maxLength, 524_288)
  assert.equal(diagnosis.additionalProperties, false)
  assert.equal(diagnosis.properties.evidence.maxItems, 50)
  assert.deepEqual(diagnosis.properties.category.enum, ['product_defect', 'script_defect', 'selector_changed', 'environment_defect', 'test_data_defect', 'flaky', 'assertion_mismatch', 'timeout', 'unknown'])
  assert.equal(repair.additionalProperties, false)
  assert.ok(repair.required.includes('parentScriptRevisionId'))
  assert.equal(repair.properties.files.items.properties.content.maxLength, 524_288)
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
    properties: { cases: { minItems: number; items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } } }
  }
  assert.equal(descriptor.version, '1.3.0')
  assert.equal(schema.additionalProperties, false)
  assert.ok(schema.required.includes('cases'))
  assert.equal(schema.properties.cases.minItems, 1)
  assert.equal(schema.properties.cases.items.additionalProperties, false)
  assert.ok(schema.properties.cases.items.required.includes('ref'))
  assert.ok(schema.properties.cases.items.required.includes('requirementRefs'))
})

test('测试用例与修复提交工具声明闭合的 test-case/v2、executionSpec 与 Proposal 层级', () => {
  for (const toolId of ['test_design_cases.submit_result', 'test_design_repair.submit_result']) {
  const schema = defaultBuiltInToolConfigResolver.toDescriptor(toolId).parameters as unknown as {
    additionalProperties: boolean
    properties: {
      cases: { minItems: number; items: { additionalProperties: boolean; required: string[]; properties: Record<string, { minItems?: number }> } }
      scenarioClaims: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: string[]; minItems?: number; required?: string[] }> } }
      dataRequirements: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, { description?: string }> } }
      proposals: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } }
    }
  }
  const caseSchema = schema.properties.cases.items
  const dataSchema = schema.properties.dataRequirements.items
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.cases.minItems, 1)
  assert.equal(caseSchema.additionalProperties, false)
  assert.ok(caseSchema.required.includes('preconditions'))
  assert.ok(caseSchema.required.includes('executionMethods'))
  assert.ok(caseSchema.required.includes('executionSpec'))
  assert.equal(caseSchema.properties.executionMethods.minItems, 0)
  const scenarioSchema = schema.properties.scenarioClaims.items
  assert.equal(scenarioSchema.additionalProperties, false)
  assert.deepEqual(scenarioSchema.required, ['ref', 'caseRef', 'requirementRefs', 'kind', 'subject', 'variant', 'polarity', 'oracle'])
  assert.equal(scenarioSchema.properties.requirementRefs.minItems, 1)
  assert.deepEqual(scenarioSchema.properties.polarity.enum, ['positive', 'negative', 'neutral'])
  assert.deepEqual(scenarioSchema.properties.transition.required, ['from', 'to'])
  assert.equal(schema.properties.proposals.items.additionalProperties, false)
  assert.ok(schema.properties.proposals.items.required.includes('operation'))
  assert.ok(schema.properties.proposals.items.required.includes('confidence'))
  assert.ok(!('preConditions' in caseSchema.properties))
  assert.ok(!('steps' in caseSchema.properties))
  assert.equal(dataSchema.additionalProperties, false)
  assert.ok(dataSchema.required.includes('caseRefs'))
  assert.ok(dataSchema.required.includes('fieldConstraints'))
  }
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
      optionalTags: { type: 'array', minItems: 1, maxItems: 2, items: { enum: ['a', 'b'] } },
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
      optionalTags: { minItems: number; maxItems: number; items: { enum: string[] } }
      fixed: { const: string }
    }
  }
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required.sort(), ['fixed', 'requiredText'])
  assert.deepEqual(schema.properties.requiredText, { type: 'string', minLength: 1, maxLength: 5, description: 'required text' })
  assert.equal(schema.properties.optionalTags.minItems, 1)
  assert.equal(schema.properties.optionalTags.maxItems, 2)
  assert.equal(schema.properties.fixed.const, 'fixed-value')
})

test('built-in binding tokens change when descriptor configuration changes', () => {
  const changed = cloneConfig()
  changed.tools['knowledge.search'].description = 'changed descriptor'
  const resolver = new BuiltInToolConfigResolver(validateBuiltInToolConfig(changed))
  assert.notEqual(builtInToolBindingToken('knowledge.search'), builtInToolBindingToken('knowledge.search', resolver))
})
