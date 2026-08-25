import { createHash } from 'node:crypto'
import type { FrozenExecutionTaskInput } from '../domain/test-execution-types.js'

type ExecutionEntryTask = Pick<
  FrozenExecutionTaskInput,
  'caseId' | 'method' | 'caseContent'
>

/**
 * Service-owned physical identity for generated Playwright entries.
 *
 * Every Case owns one deterministic entry file. Requirement traceability keeps
 * the path readable, while the Case hash prevents concurrent Agents from
 * publishing stale replacements of a shared spec.
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
  const requirementHash = sha256(requirementRefs.join('\u0000')).slice(0, 12)
  const caseHash = sha256(task.caseId).slice(0, 12)
  return `tests/${task.method}/requirement-${group}-${requirementHash}-case-${caseHash}.spec.ts`
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
