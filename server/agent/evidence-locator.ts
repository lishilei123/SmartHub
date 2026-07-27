export interface LocatableEvidenceChunk {
  id: string
  assetVersionId: string
  ordinal: number
  content: string
  contentHash: string
  headingPath: string[]
  startChar: number
}

export interface ResolvedEvidenceQuote {
  chunk: LocatableEvidenceChunk
  quote: string
  offset: number
  strategy: 'exact' | 'markdown_visible' | 'trailing_ellipsis' | 'asset_rebound_exact' | 'asset_rebound_markdown_visible' | 'asset_rebound_trailing_ellipsis'
}

export function resolveEvidenceQuote(input: {
  quote: string
  chunkId: string
  assetVersionId: string
}, chunks: readonly LocatableEvidenceChunk[]): ResolvedEvidenceQuote | undefined {
  const quote = String(input.quote ?? '').trim()
  const visibleQuote = projectVisibleText(quote).text
  if (visibleQuote.replace(/\s/gu, '').length < 4) return undefined
  const assetChunks = chunks.filter(chunk => chunk.assetVersionId === input.assetVersionId)
  const claimed = assetChunks.find(chunk => chunk.id === input.chunkId)
  if (claimed) {
    const direct = locateInChunk(claimed, quote, visibleQuote)
    if (direct) return { ...direct, strategy: direct.strategy === 'exact' ? 'exact' : 'markdown_visible' }
  }

  const rebound = uniqueAssetMatch(assetChunks, quote, visibleQuote)
  if (rebound) return { ...rebound, strategy: rebound.strategy === 'exact' ? 'asset_rebound_exact' : 'asset_rebound_markdown_visible' }

  const repairedQuote = withoutTrailingEllipsis(quote)
  if (repairedQuote === quote || projectVisibleText(repairedQuote).text.length < 4) return undefined
  const repairedVisibleQuote = projectVisibleText(repairedQuote).text
  if (claimed) {
    const direct = locateInChunk(claimed, repairedQuote, repairedVisibleQuote)
    if (direct) return { chunk: direct.chunk, quote: direct.quote, offset: direct.offset, strategy: 'trailing_ellipsis' }
  }
  const repairedRebound = uniqueAssetMatch(assetChunks, repairedQuote, repairedVisibleQuote)
  return repairedRebound ? { chunk: repairedRebound.chunk, quote: repairedRebound.quote, offset: repairedRebound.offset, strategy: 'asset_rebound_trailing_ellipsis' } : undefined
}

function uniqueAssetMatch(assetChunks: readonly LocatableEvidenceChunk[], quote: string, visibleQuote: string) {
  const candidates = assetChunks.flatMap(chunk => {
    const match = locateInChunk(chunk, quote, visibleQuote)
    return match ? [{ ...match, absoluteStart: chunk.startChar + match.offset, absoluteEnd: chunk.startChar + match.offset + match.quote.length }] : []
  })
  if (!candidates.length) return undefined
  const locations = new Set(candidates.map(candidate => `${candidate.absoluteStart}:${candidate.absoluteEnd}`))
  if (locations.size > 1) return undefined
  return candidates.sort((left, right) => Number(left.strategy !== 'exact') - Number(right.strategy !== 'exact') || left.chunk.ordinal - right.chunk.ordinal)[0]
}

function withoutTrailingEllipsis(value: string) {
  return value.replace(/(?:\.{3,}|…+)\s*$/u, '').trimEnd()
}

function locateInChunk(chunk: LocatableEvidenceChunk, rawQuote: string, visibleQuote: string) {
  const exactOffset = chunk.content.indexOf(rawQuote)
  if (exactOffset >= 0) return { chunk, quote: rawQuote, offset: exactOffset, strategy: 'exact' as const }
  const projection = projectVisibleText(chunk.content)
  const visibleOffset = projection.text.indexOf(visibleQuote)
  if (visibleOffset < 0 || !visibleQuote) return undefined
  const rawStart = projection.rawOffsets[visibleOffset]
  const rawEnd = projection.rawOffsets[visibleOffset + visibleQuote.length - 1] + 1
  return { chunk, quote: chunk.content.slice(rawStart, rawEnd), offset: rawStart, strategy: 'markdown_visible' as const }
}

function projectVisibleText(source: string) {
  const characters: string[] = []
  const offsets: number[] = []
  let lineStart = true
  for (let index = 0; index < source.length;) {
    if (lineStart) {
      const marker = source.slice(index).match(/^(?: {0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+)/u)?.[0]
      if (marker) { index += marker.length; lineStart = false; continue }
    }
    const current = source[index]
    if (current === '\r' && source[index + 1] === '\n') { push('\n', index); index += 2; lineStart = true; continue }
    if (current === '\n') { push('\n', index); index += 1; lineStart = true; continue }
    lineStart = false
    if (current === '\\' && index + 1 < source.length) { push(source[index + 1], index + 1); index += 2; continue }
    if (current === '`') { while (source[index] === '`') index += 1; continue }
    if ((current === '*' || current === '_' || current === '~') && source[index + 1] === current) { index += 2; continue }
    if (current === '!' && source[index + 1] === '[') { index += 1; continue }
    if (current === '[' || current === ']') {
      if (current === ']' && source[index + 1] === '(') {
        index += 2
        let depth = 1
        while (index < source.length && depth > 0) {
          if (source[index] === '(') depth += 1
          if (source[index] === ')') depth -= 1
          index += 1
        }
      } else index += 1
      continue
    }
    push(current, index)
    index += 1
  }

  const collapsed: string[] = []
  const collapsedOffsets: number[] = []
  characters.forEach((character, index) => {
    if (/\s/u.test(character)) return
    collapsed.push(character)
    collapsedOffsets.push(offsets[index])
  })
  return { text: collapsed.join(''), rawOffsets: collapsedOffsets }

  function push(character: string, offset: number) { characters.push(character); offsets.push(offset) }
}
