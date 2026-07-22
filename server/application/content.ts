import { createHash } from 'node:crypto'
import { toString } from 'mdast-util-to-string'
import { getEncoding } from 'js-tiktoken'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import type { RootContent } from 'mdast'
import type { Chunk, KnowledgeConfig } from '../domain/types.js'

export interface TokenCodec {
  count(text: string): number
  maxTokens?: number
}

const cl100k = getEncoding('cl100k_base')
export const defaultTokenCodec: TokenCodec = { count: text => cl100k.encode(text).length, maxTokens: 8191 }

export const sha256 = (value: string) => createHash('sha256').update(value.normalize('NFC')).digest('hex')

/** Deterministic fallback used by isolated unit tests without an injected model runtime. */
export function embedding(text: string, dimensions: number) {
  const vector = Array.from({ length: dimensions }, () => 0)
  const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []
  for (const term of terms) {
    const digest = createHash('sha256').update(term).digest()
    const index = digest.readUInt32BE(0) % dimensions
    vector[index] += digest[4] % 2 ? 1 : -1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

export const cosine = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)

type Unit = { start: number; end: number; type: RootContent['type'] }
type Section = { headingPath: string[]; units: Unit[] }
type Draft = { headingPath: string[]; start: number; end: number }

export function chunkDocument(content: string, config: KnowledgeConfig, previous: Chunk[] = [], tokenizer: TokenCodec = defaultTokenCodec) {
  const maximumAllowed = tokenizer.maxTokens ? Math.max(1, tokenizer.maxTokens - 2) : config.chunkMaxSize
  const maximum = Math.min(config.chunkMaxSize, maximumAllowed)
  const target = Math.min(config.chunkTargetSize, maximum)
  const overlap = Math.min(config.chunkOverlap, Math.max(0, target - 1))
  const sections = markdownSections(content, config.headingDepth)
  const drafts = sections.flatMap(section => chunkSection(content, section, tokenizer, target, maximum, overlap))
  const lineStarts = collectLineStarts(content)
  const priorByIdentity = new Map<string, Chunk[]>()
  for (const chunk of previous) {
    const identity = `${chunk.headingPath.join('>')}|${chunk.contentHash}`
    const matches = priorByIdentity.get(identity) ?? []
    matches.push(chunk)
    priorByIdentity.set(identity, matches)
  }
  const occurrences = new Map<string, number>()

  return drafts.map((draft, ordinal) => {
    const range = trimRange(content, draft.start, draft.end)
    const text = content.slice(range.start, range.end)
    const contentHash = sha256(text)
    const identity = `${draft.headingPath.join('>')}|${contentHash}`
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    const prior = priorByIdentity.get(identity)?.shift()
    return {
      id: crypto.randomUUID(),
      chunkKey: prior?.chunkKey ?? sha256(`${draft.headingPath.join('/')}:${contentHash}:${occurrence}`).slice(0, 24),
      assetVersionId: '',
      ordinal,
      headingPath: draft.headingPath,
      content: text,
      contentHash,
      tokenCount: tokenizer.count(text),
      startLine: lineAt(lineStarts, range.start),
      endLine: lineAt(lineStarts, Math.max(range.start, range.end - 1)),
      startChar: range.start,
      endChar: range.end,
      embedding: prior?.embedding ?? [],
      reused: Boolean(prior),
    } satisfies Chunk
  })
}

function markdownSections(content: string, headingDepth: number) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(content)
  const sections: Section[] = []
  let headingPath: string[] = []
  let current: Section | null = null
  for (const node of tree.children) {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start == null || end == null || end <= start) continue
    if (node.type === 'heading') {
      if (current?.units.length) sections.push(current)
      const depth = Math.min(node.depth, headingDepth)
      headingPath = [...headingPath.slice(0, depth - 1), toString(node).trim()]
      current = { headingPath: [...headingPath], units: [] }
    }
    current ??= { headingPath: [...headingPath], units: [] }
    current.units.push({ start, end, type: node.type })
  }
  if (current?.units.length) sections.push(current)
  return sections
}

function chunkSection(content: string, section: Section, tokenizer: TokenCodec, target: number, maximum: number, overlap: number) {
  const drafts: Draft[] = []
  let currentStart: number | null = null
  let currentEnd: number | null = null
  let carryOnly = false

  const push = (start: number, end: number) => {
    const trimmed = trimRange(content, start, end)
    if (trimmed.end > trimmed.start) drafts.push({ headingPath: section.headingPath, ...trimmed })
  }

  for (const unit of section.units) {
    if (currentStart != null && currentEnd != null) {
      const candidateTokens = tokenizer.count(content.slice(currentStart, unit.end))
      if (candidateTokens <= target || (carryOnly && candidateTokens <= maximum)) { currentEnd = unit.end; carryOnly = false; continue }
      if (!carryOnly) push(currentStart, currentEnd)
      const priorUnit = section.units.find(item => item.end === currentEnd)
      currentStart = priorUnit && isProtected(priorUnit) ? null : overlapStart(content, currentStart, currentEnd, overlap, tokenizer)
      currentEnd = currentStart == null ? null : currentEnd
      carryOnly = currentStart != null
      if (currentStart != null && tokenizer.count(content.slice(currentStart, unit.end)) > maximum) { currentStart = null; currentEnd = null }
    }

    const unitTokens = tokenizer.count(content.slice(unit.start, unit.end))
    if (unitTokens > maximum && !isProtected(unit)) {
      for (const range of splitRange(content, unit.start, unit.end, maximum, overlap, tokenizer)) push(range.start, range.end)
      const last = drafts.at(-1)
      currentStart = last ? overlapStart(content, last.start, last.end, overlap, tokenizer) : null
      currentEnd = currentStart == null || !last ? null : last.end
      carryOnly = currentStart != null
      continue
    }
    currentStart ??= unit.start
    currentEnd = unit.end
    carryOnly = false
    if (unitTokens >= target || isProtected(unit)) {
      push(currentStart, currentEnd)
      currentStart = isProtected(unit) ? null : overlapStart(content, currentStart, currentEnd, overlap, tokenizer)
      currentEnd = currentStart == null ? null : unit.end
      carryOnly = currentStart != null
    }
  }
  if (!carryOnly && currentStart != null && currentEnd != null) push(currentStart, currentEnd)
  return deduplicateDrafts(drafts)
}

function splitRange(content: string, start: number, end: number, maximum: number, overlap: number, tokenizer: TokenCodec) {
  const ranges: { start: number; end: number }[] = []
  let cursor = start
  while (cursor < end) {
    const cut = largestEndWithin(content, cursor, end, maximum, tokenizer)
    const safeCut = cut > cursor ? cut : nextCodePoint(content, cursor)
    ranges.push({ start: cursor, end: safeCut })
    if (safeCut >= end) break
    const next = overlapStart(content, cursor, safeCut, overlap, tokenizer)
    cursor = next != null && next > cursor ? next : safeCut
  }
  return ranges
}

function largestEndWithin(content: string, start: number, end: number, limit: number, tokenizer: TokenCodec) {
  let low = start + 1
  let high = end
  let best = start
  while (low <= high) {
    const middle = validBoundary(content, Math.floor((low + high) / 2))
    const tokens = tokenizer.count(content.slice(start, middle))
    if (tokens <= limit) { best = Math.max(best, middle); low = middle + 1 }
    else high = middle - 1
  }
  return best
}

function overlapStart(content: string, start: number, end: number, overlap: number, tokenizer: TokenCodec) {
  if (!overlap || end <= start) return null
  let low = start
  let high = end - 1
  let best = end
  while (low <= high) {
    const middle = validBoundary(content, Math.floor((low + high) / 2))
    const tokens = tokenizer.count(content.slice(middle, end))
    if (tokens <= overlap) { best = Math.min(best, middle); high = middle - 1 }
    else low = middle + 1
  }
  return best < end ? best : null
}

function isProtected(unit: Unit) { return unit.type === 'code' || unit.type === 'table' }

function validBoundary(content: string, index: number) {
  if (index > 0 && index < content.length) {
    const value = content.charCodeAt(index)
    if (value >= 0xdc00 && value <= 0xdfff) return index - 1
  }
  return index
}

function nextCodePoint(content: string, index: number) { return index + (content.codePointAt(index)! > 0xffff ? 2 : 1) }

function trimRange(content: string, start: number, end: number) {
  while (start < end && /\s/u.test(content[start])) start += 1
  while (end > start && /\s/u.test(content[end - 1])) end -= 1
  return { start, end }
}

function deduplicateDrafts(drafts: Draft[]) {
  return drafts.filter((draft, index) => index === 0 || draft.start !== drafts[index - 1].start || draft.end !== drafts[index - 1].end)
}

function collectLineStarts(content: string) {
  const starts = [0]
  for (let index = 0; index < content.length; index += 1) if (content[index] === '\n') starts.push(index + 1)
  return starts
}

function lineAt(starts: number[], offset: number) {
  let low = 0
  let high = starts.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= offset) low = middle + 1
    else high = middle - 1
  }
  return high + 1
}
