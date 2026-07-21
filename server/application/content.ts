import { createHash } from 'node:crypto'
import type { Chunk, KnowledgeConfig } from '../domain/types.js'

export const sha256 = (value: string) => createHash('sha256').update(value.normalize('NFC')).digest('hex')

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

export function chunkDocument(content: string, config: KnowledgeConfig, previous: Chunk[] = []) {
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const blocks: { headingPath: string[]; lines: string[]; startLine: number; endLine: number }[] = []
  let headings: string[] = []
  let current: typeof blocks[number] | null = null
  const flush = () => { if (current && current.lines.join('\n').trim()) blocks.push(current); current = null }
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      const depth = Math.min(heading[1].length, config.headingDepth)
      headings = [...headings.slice(0, depth - 1), heading[2].trim()]
    }
    if (!current) current = { headingPath: [...headings], lines: [], startLine: index + 1, endLine: index + 1 }
    current.lines.push(line); current.endLine = index + 1
    if (current.lines.join('\n').length >= config.chunkTargetSize && !/^\s*```/.test(line)) flush()
  })
  flush()
  const priorByIdentity = new Map(previous.map(chunk => [`${chunk.headingPath.join('>')}|${chunk.contentHash}`, chunk]))
  let cursor = 0
  return blocks.map((block, ordinal) => {
    const text = block.lines.join('\n').trim()
    const contentHash = sha256(text)
    const identity = `${block.headingPath.join('>')}|${contentHash}`
    const prior = priorByIdentity.get(identity)
    const startChar = content.indexOf(text, cursor); cursor = Math.max(cursor, startChar + text.length)
    return { id: crypto.randomUUID(), chunkKey: prior?.chunkKey ?? sha256(`${block.headingPath.join('/')}:${contentHash}`).slice(0, 24), assetVersionId: '', ordinal, headingPath: block.headingPath, content: text, contentHash, startLine: block.startLine, endLine: block.endLine, startChar: Math.max(0, startChar), endChar: Math.max(0, startChar) + text.length, embedding: prior?.embedding ?? embedding(text, config.embeddingDimensions), reused: Boolean(prior) }
  })
}
