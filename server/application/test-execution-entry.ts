import { createHash } from 'node:crypto'
import type { FrozenExecutionTaskInput } from '../domain/test-execution-types.js'

type ExecutionEntryTask = Pick<
  FrozenExecutionTaskInput,
  'caseId' | 'method' | 'caseContent'
>

/**
 * Service-owned physical grouping for generated Playwright entries.
 *
 * Cases with the same formal Requirement set and execution method share one
 * spec. Cases without direct Requirement traceability keep an isolated entry
 * because the Service has no deterministic business grouping fact for them.
 */
export function governedExecutionEntryFile(task: ExecutionEntryTask) {
  if (task.method !== 'ui' && task.method !== 'api') {
    throw new Error('TEST_EXECUTION_ENTRY_METHOD_UNSUPPORTED')
  }
  const requirementRefs = [...new Set(task.caseContent.requirementRefs
    .map(value => value.trim())
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'))
  if (!requirementRefs.length) {
    return `tests/${task.method}/case-${sha256(task.caseId).slice(0, 32)}.spec.ts`
  }
  const readable = requirementRefs[0]
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  const group = readable || 'group'
  return `tests/${task.method}/requirement-${group}-${sha256(requirementRefs.join('\u0000')).slice(0, 12)}.spec.ts`
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
