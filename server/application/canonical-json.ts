import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const serialize = (input: unknown): string => {
    if (input === null) return 'null'
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input)
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('CANONICAL_JSON_NON_FINITE_NUMBER')
      return Object.is(input, -0) ? '0' : JSON.stringify(input)
    }
    if (typeof input === 'undefined') throw new Error('CANONICAL_JSON_UNDEFINED')
    if (typeof input !== 'object') throw new Error(`CANONICAL_JSON_UNSUPPORTED_TYPE: ${typeof input}`)
    if (ancestors.has(input)) throw new Error('CANONICAL_JSON_CIRCULAR_REFERENCE')
    ancestors.add(input)
    try {
      if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`
      const prototype = Object.getPrototypeOf(input)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('CANONICAL_JSON_NON_PLAIN_OBJECT')
      const record = input as Record<string, unknown>
      const keys = Object.keys(record).sort(compareCodePoints)
      return `{${keys.map(key => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`
    } finally {
      ancestors.delete(input)
    }
  }
  return serialize(value)
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function compareCodePoints(left: string, right: string) {
  const leftPoints = Array.from(left, character => character.codePointAt(0)!)
  const rightPoints = Array.from(right, character => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index]
  }
  return leftPoints.length - rightPoints.length
}
