import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInToolBindingToken } from '../server/application/ai-resource-hash.js'
import { BuiltInToolConfigResolver, defaultBuiltInToolConfig, defaultBuiltInToolConfigResolver, validateBuiltInToolConfig } from '../server/tools/built-in-tool-config.js'
import { ToolRegistry } from '../server/tools/registry.js'

const cloneConfig = () => structuredClone(defaultBuiltInToolConfig)

test('checked-in built-in Tool config defines thirteen catalog tools and two hidden runtime tools', () => {
  assert.equal(defaultBuiltInToolConfigResolver.keys().length, 15)
  assert.equal(defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).length, 13)
  assert.ok(!defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).includes('skill.execute_script'))
  assert.equal(defaultBuiltInToolConfigResolver.toToolResource('knowledge.search').source, 'builtin')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('skill.http_request').piName, 'skill_http_request')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('test_case_synthesis.submit_result').piName, 'test_case_synthesis_submit_result')
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

test('测试点提交工具向模型声明完整临时引用和节点字段', () => {
  for (const key of ['functional_test_design.submit_result', 'non_functional_test_design.submit_result']) {
    const schema = defaultBuiltInToolConfigResolver.toDescriptor(key).parameters as unknown as { additionalProperties: boolean; properties: { nodes: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } } } }
    assert.equal(schema.additionalProperties, false)
    assert.equal(schema.properties.nodes.items.additionalProperties, false)
    assert.ok(schema.properties.nodes.items.required.includes('ref'))
    assert.ok(schema.properties.nodes.items.required.includes('basisRefs'))
    assert.ok('parentRef' in schema.properties.nodes.items.properties)
  }
  const nonFunctional = defaultBuiltInToolConfigResolver.toDescriptor('non_functional_test_design.submit_result')
  assert.equal(nonFunctional.version, '1.2.0')
  assert.match(nonFunctional.description, /同一个 nodes 数组/u)
})

test('测试分析提交工具声明可展示的闭合结果结构', () => {
  const descriptor = defaultBuiltInToolConfigResolver.toDescriptor('test_analysis.submit_result')
  const schema = descriptor.parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { coverageUnits: { minItems: number; items: { additionalProperties: boolean; required: string[] } } }
  }
  assert.equal(descriptor.version, '1.1.0')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['schemaVersion', 'scope', 'coverageUnits', 'findings', 'confirmationItems'])
  assert.equal(schema.properties.coverageUnits.minItems, 1)
  assert.equal(schema.properties.coverageUnits.items.additionalProperties, false)
  assert.ok(schema.properties.coverageUnits.items.required.includes('basisRefs'))
  assert.ok(schema.properties.coverageUnits.items.required.includes('oracles'))
})

test('测试用例综合工具声明闭合的 test-case/v1 层级', () => {
  const schema = defaultBuiltInToolConfigResolver.toDescriptor('test_case_synthesis.submit_result').parameters as unknown as {
    additionalProperties: boolean
    properties: {
      cases: { minItems: number; items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } }
      dataRequirements: { items: { additionalProperties: boolean; required: string[]; properties: Record<string, { description?: string }> } }
    }
  }
  const caseSchema = schema.properties.cases.items
  const dataSchema = schema.properties.dataRequirements.items
  assert.equal(schema.additionalProperties, false)
  assert.equal(schema.properties.cases.minItems, 1)
  assert.equal(caseSchema.additionalProperties, false)
  assert.ok(caseSchema.required.includes('preconditions'))
  assert.ok(caseSchema.required.includes('executionMethods'))
  assert.ok(!('preConditions' in caseSchema.properties))
  assert.ok(!('steps' in caseSchema.properties))
  assert.equal(dataSchema.additionalProperties, false)
  assert.ok(dataSchema.required.includes('caseIndexes'))
  assert.match(dataSchema.properties.fieldConstraints.description ?? '', /noProductionData.*字符串/u)
})

test('legacy technical-review descriptor remains v1 while the default descriptor remains v2', () => {
  const legacy = defaultBuiltInToolConfigResolver.toDescriptor('technical_solution_review.submit_result', 'legacy-candidate').parameters as unknown as { properties: Record<string, unknown>; required: string[] }
  const current = defaultBuiltInToolConfigResolver.toDescriptor('technical_solution_review.submit_result').parameters as unknown as { properties: Record<string, unknown>; required: string[] }
  assert.equal((legacy.properties.schemaVersion as { const: string }).const, 'technical-solution-review/v1')
  assert.equal((current.properties.schemaVersion as { const: string }).const, 'technical-solution-review/v2')
  assert.ok('coverageCandidates' in legacy.properties)
  assert.ok('coverage' in current.properties)
  assert.deepEqual((legacy.properties.summary as { additionalProperties: boolean }).additionalProperties, false)
  assert.deepEqual((legacy.properties.findings as { items: { additionalProperties: boolean } }).items.additionalProperties, false)
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
  privilegedVariant.tools['technical_solution_review.submit_result'].variants!['legacy-candidate'] = {
    ...privilegedVariant.tools['technical_solution_review.submit_result'].variants!['legacy-candidate'],
    piName: 'other_name',
  } as never
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
