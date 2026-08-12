import assert from 'node:assert/strict'
import test from 'node:test'
import { builtInToolBindingToken } from '../server/application/ai-resource-hash.js'
import { BuiltInToolConfigResolver, defaultBuiltInToolConfig, defaultBuiltInToolConfigResolver, validateBuiltInToolConfig } from '../server/tools/built-in-tool-config.js'
import { ToolRegistry } from '../server/tools/registry.js'

const cloneConfig = () => structuredClone(defaultBuiltInToolConfig)

test('checked-in built-in Tool config includes the unified requirement-analysis submission tool', () => {
  assert.equal(defaultBuiltInToolConfigResolver.keys().length, 15)
  assert.equal(defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).length, 13)
  assert.ok(!defaultBuiltInToolConfigResolver.keys({ catalogVisibleOnly: true }).includes('skill.execute_script'))
  assert.equal(defaultBuiltInToolConfigResolver.toToolResource('knowledge.search').source, 'builtin')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.read_file').piName, 'read')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('workspace.list_directory').piName, 'ls')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('skill.http_request').piName, 'skill_http_request')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('skill.activate').piName, 'skill_activate')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('test_design_cases.submit_result').piName, 'test_design_cases_submit_result')
  assert.equal(defaultBuiltInToolConfigResolver.toDescriptor('requirement-analysis.submit_result').piName, 'requirement_analysis_submit_result')
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
  const descriptor = defaultBuiltInToolConfigResolver.toDescriptor('test_design_points.submit_result')
  const schema = descriptor.parameters as unknown as {
    additionalProperties: boolean
    required: string[]
    properties: { nodes: { minItems: number; items: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> } } }
  }
  assert.equal(descriptor.version, '1.0.0')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['schemaVersion', 'nodes', 'findings', 'confirmationItems'])
  assert.equal(schema.properties.nodes.minItems, 1)
  assert.equal(schema.properties.nodes.items.additionalProperties, false)
  assert.ok(schema.properties.nodes.items.required.includes('ref'))
  assert.ok(schema.properties.nodes.items.required.includes('basisRefs'))
  assert.ok(schema.properties.nodes.items.required.includes('entryMethods'))
  assert.ok('parentRef' in schema.properties.nodes.items.properties)
})

test('测试用例与修复提交工具声明闭合的 test-case/v1 层级', () => {
  for (const toolId of ['test_design_cases.submit_result', 'test_design_repair.submit_result']) {
  const schema = defaultBuiltInToolConfigResolver.toDescriptor(toolId).parameters as unknown as {
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
