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
  strategy: 'exact' | 'markdown_visible' | 'source_search' | 'fragment_search' | 'asset_rebound_exact' | 'asset_rebound_markdown_visible' | 'asset_rebound_source_search' | 'asset_rebound_fragment_search'
}

export interface EvidenceSearchCandidate {
  chunk: LocatableEvidenceChunk
  quote: string
  offset: number
  score: number
}

export interface ResolvedSourceText extends EvidenceSearchCandidate {
  strategy: 'exact' | 'markdown_visible' | 'source_search' | 'fragment_search' | 'retrieval_candidate'
}

export const EVIDENCE_RETRIEVAL_MIN_CONFIDENCE = 0.45
export const EVIDENCE_RETRIEVAL_CONFIDENCE_WINDOW = 0.08

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

  const sourceQuery = withoutTrailingEllipsis(quote)
  const normalizedQuery = projectSearchText(sourceQuery).text
  if (normalizedQuery.length >= 8 && claimed) {
    const searched = locateSourceQueryInChunk(claimed, normalizedQuery)
    if (searched) return { ...searched, strategy: 'source_search' }
  }
  if (normalizedQuery.length >= 8) {
    const searched = uniqueAssetSourceSearch(assetChunks, normalizedQuery)
    if (searched) return { ...searched, strategy: 'asset_rebound_source_search' }
  }

  const fragments = quote.split(/(?:\.{3,}|…+)/u).map(value => projectSearchText(value).text).filter(value => value.length >= 4)
  if (fragments.length < 2) return undefined
  if (claimed) {
    const searched = locateFragmentsInChunk(claimed, fragments)
    if (searched) return { ...searched, strategy: 'fragment_search' }
  }
  const searched = uniqueAssetFragmentSearch(assetChunks, fragments)
  return searched ? { ...searched, strategy: 'asset_rebound_fragment_search' } : undefined
}

export function searchEvidenceCandidates(input: {
  quote: string
  chunkId?: string
  assetVersionId?: string
}, chunks: readonly LocatableEvidenceChunk[], requirementText = ''): EvidenceSearchCandidate[] {
  const quoteFeatures = searchFeatures(input.quote)
  const requirementFeatures = searchFeatures(requirementText)
  if (!quoteFeatures.size && !requirementFeatures.size) return []
  const candidates = chunks.filter(chunk => !input.assetVersionId || chunk.assetVersionId === input.assetVersionId).flatMap(chunk => sourceLines(chunk).map(line => {
    const lineFeatures = searchFeatures(line.quote)
    const quoteScore = featureCoverage(quoteFeatures, lineFeatures)
    const requirementScore = featureCoverage(lineFeatures, requirementFeatures)
    const score = (quoteFeatures.size ? quoteScore * 0.8 : 0) + (requirementFeatures.size ? requirementScore * 0.2 : 0) + (chunk.id === input.chunkId ? 0.05 : 0)
    return { chunk, quote: line.quote, offset: line.offset, score: Math.min(1, score) }
  })).filter(candidate => candidate.score >= 0.15)
  const unique = new Map<string, EvidenceSearchCandidate>()
  candidates.forEach(candidate => {
    const key = `${candidate.chunk.assetVersionId}:${candidate.chunk.startChar + candidate.offset}:${candidate.chunk.startChar + candidate.offset + candidate.quote.length}`
    if ((unique.get(key)?.score ?? -1) < candidate.score) unique.set(key, candidate)
  })
  return [...unique.values()].sort((left, right) => right.score - left.score || left.chunk.ordinal - right.chunk.ordinal || left.offset - right.offset)
}

export function resolveEvidenceSourceText(sourceText: string, chunks: readonly LocatableEvidenceChunk[], requirementText = ''): ResolvedSourceText[] {
  const quote = String(sourceText ?? '').trim()
  const visibleQuote = projectVisibleText(quote).text
  if (visibleQuote.replace(/\s/gu, '').length < 4) return []

  const direct = uniqueResolvedLocations(chunks.flatMap(chunk => {
    return locateAllInChunk(chunk, quote, visibleQuote).map(match => ({ ...match, score: 1, strategy: match.strategy }))
  }))
  if (direct.length) return direct

  const normalizedQuery = projectSearchText(withoutTrailingEllipsis(quote)).text
  if (normalizedQuery.length >= 8) {
    const searched = uniqueResolvedLocations(chunks.flatMap(chunk => {
      return locateAllSourceQueriesInChunk(chunk, normalizedQuery).map(match => ({ ...match, score: 0.98, strategy: 'source_search' as const }))
    }))
    if (searched.length) return searched
  }

  const fragments = quote.split(/(?:\.{3,}|…+)/u).map(value => projectSearchText(value).text).filter(value => value.length >= 4)
  if (fragments.length >= 2) {
    const searched = uniqueResolvedLocations(chunks.flatMap(chunk => {
      const match = locateFragmentsInChunk(chunk, fragments)
      return match ? [{ ...match, score: 0.95, strategy: 'fragment_search' as const }] : []
    }))
    if (searched.length) return searched
  }

  const candidates = searchEvidenceCandidates({ quote }, chunks, requirementText)
  const top = candidates[0]
  if (!top || top.score < EVIDENCE_RETRIEVAL_MIN_CONFIDENCE) return []
  const confidenceFloor = Math.max(EVIDENCE_RETRIEVAL_MIN_CONFIDENCE, top.score - EVIDENCE_RETRIEVAL_CONFIDENCE_WINDOW)
  return candidates.filter(candidate => candidate.score >= confidenceFloor).map(candidate => ({ ...candidate, strategy: 'retrieval_candidate' }))
}

function uniqueResolvedLocations<T extends EvidenceSearchCandidate & { strategy: ResolvedSourceText['strategy'] }>(candidates: T[]): T[] {
  const unique = new Map<string, T>()
  candidates.forEach(candidate => {
    const key = `${candidate.chunk.assetVersionId}:${candidate.chunk.startChar + candidate.offset}:${candidate.chunk.startChar + candidate.offset + candidate.quote.length}`
    if (!unique.has(key)) unique.set(key, candidate)
  })
  return [...unique.values()].sort((left, right) => left.chunk.assetVersionId.localeCompare(right.chunk.assetVersionId) || left.chunk.ordinal - right.chunk.ordinal || left.offset - right.offset)
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

function uniqueAssetSourceSearch(assetChunks: readonly LocatableEvidenceChunk[], normalizedQuery: string) {
  return uniqueLocation(assetChunks.flatMap(chunk => {
    const match = locateSourceQueryInChunk(chunk, normalizedQuery)
    return match ? [match] : []
  }))
}

function uniqueAssetFragmentSearch(assetChunks: readonly LocatableEvidenceChunk[], fragments: string[]) {
  return uniqueLocation(assetChunks.flatMap(chunk => {
    const match = locateFragmentsInChunk(chunk, fragments)
    return match ? [match] : []
  }))
}

function uniqueLocation<T extends { chunk: LocatableEvidenceChunk; quote: string; offset: number }>(candidates: T[]): T | undefined {
  if (!candidates.length) return undefined
  const locations = new Set(candidates.map(candidate => `${candidate.chunk.startChar + candidate.offset}:${candidate.chunk.startChar + candidate.offset + candidate.quote.length}`))
  if (locations.size !== 1) return undefined
  return candidates.sort((left, right) => left.chunk.ordinal - right.chunk.ordinal)[0]
}

function locateSourceQueryInChunk(chunk: LocatableEvidenceChunk, normalizedQuery: string) {
  const matches = locateAllSourceQueriesInChunk(chunk, normalizedQuery)
  return matches.length === 1 ? matches[0] : undefined
}

function locateAllSourceQueriesInChunk(chunk: LocatableEvidenceChunk, normalizedQuery: string) {
  const projection = projectSearchText(chunk.content)
  return allIndexesOf(projection.text, normalizedQuery).flatMap(offset => {
    const match = rawProjectionMatch(chunk, projection.rawOffsets, offset, offset + normalizedQuery.length)
    return match ? [match] : []
  })
}

function locateFragmentsInChunk(chunk: LocatableEvidenceChunk, fragments: string[]) {
  const projection = projectSearchText(chunk.content)
  const candidates = allIndexesOf(projection.text, fragments[0]).flatMap(start => {
    const ends = orderedFragmentEnds(projection.text, fragments, 1, start + fragments[0].length)
    return ends.map(end => rawProjectionMatch(chunk, projection.rawOffsets, start, end))
  })
  const matches = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
  return matches.length === 1 ? matches[0] : undefined
}

function orderedFragmentEnds(source: string, fragments: string[], position: number, cursor: number): number[] {
  if (position >= fragments.length) return [cursor]
  const fragment = fragments[position]
  return allIndexesOf(source, fragment)
    .filter(offset => offset >= cursor && offset - cursor <= 2000)
    .flatMap(offset => orderedFragmentEnds(source, fragments, position + 1, offset + fragment.length))
    .slice(0, 100)
}

function rawProjectionMatch(chunk: LocatableEvidenceChunk, rawOffsets: number[], start: number, end: number) {
  const rawStart = rawOffsets[start]
  const rawEnd = rawOffsets[end - 1]
  if (rawStart === undefined || rawEnd === undefined) return undefined
  return { chunk, quote: chunk.content.slice(rawStart, rawEnd + 1), offset: rawStart }
}

function allIndexesOf(source: string, query: string) {
  const offsets: number[] = []
  for (let offset = source.indexOf(query); offset >= 0; offset = source.indexOf(query, offset + 1)) offsets.push(offset)
  return offsets
}

function sourceLines(chunk: LocatableEvidenceChunk) {
  return [...chunk.content.matchAll(/[^\r\n]+/gu)].flatMap(match => {
    const full = match[0]
    const quote = full.trim()
    if (!quote || projectSearchText(quote).text.length < 8) return []
    const leading = full.length - full.trimStart().length
    return [{ quote: Array.from(quote).slice(0, 4000).join(''), offset: (match.index ?? 0) + leading }]
  })
}

function searchFeatures(value: string) {
  const text = projectSearchText(value).text
  const features = new Set<string>()
  if (text.length === 1) features.add(text)
  for (let index = 0; index < text.length - 1; index++) features.add(text.slice(index, index + 2))
  return features
}

function featureCoverage(query: Set<string>, candidate: Set<string>) {
  if (!query.size) return 0
  let matched = 0
  query.forEach(feature => { if (candidate.has(feature)) matched += 1 })
  return matched / query.size
}

function locateInChunk(chunk: LocatableEvidenceChunk, rawQuote: string, visibleQuote: string) {
  const exactOffsets = allIndexesOf(chunk.content, rawQuote)
  if (exactOffsets.length === 1) return { chunk, quote: rawQuote, offset: exactOffsets[0], strategy: 'exact' as const }
  if (exactOffsets.length > 1) return undefined
  const projection = projectVisibleText(chunk.content)
  const visibleOffsets = allIndexesOf(projection.text, visibleQuote)
  if (visibleOffsets.length !== 1 || !visibleQuote) return undefined
  const visibleOffset = visibleOffsets[0]
  const rawStart = projection.rawOffsets[visibleOffset]
  const rawEnd = projection.rawOffsets[visibleOffset + visibleQuote.length - 1] + 1
  return { chunk, quote: chunk.content.slice(rawStart, rawEnd), offset: rawStart, strategy: 'markdown_visible' as const }
}

function locateAllInChunk(chunk: LocatableEvidenceChunk, rawQuote: string, visibleQuote: string) {
  const exactOffsets = allIndexesOf(chunk.content, rawQuote)
  if (exactOffsets.length) return exactOffsets.map(offset => ({ chunk, quote: rawQuote, offset, strategy: 'exact' as const }))
  if (!visibleQuote) return []
  const projection = projectVisibleText(chunk.content)
  return allIndexesOf(projection.text, visibleQuote).map(visibleOffset => {
    const rawStart = projection.rawOffsets[visibleOffset]
    const rawEnd = projection.rawOffsets[visibleOffset + visibleQuote.length - 1] + 1
    return { chunk, quote: chunk.content.slice(rawStart, rawEnd), offset: rawStart, strategy: 'markdown_visible' as const }
  })
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

function projectSearchText(source: string) {
  const visible = projectVisibleText(source)
  const characters: string[] = []
  const rawOffsets: number[] = []
  Array.from(visible.text).forEach((character, index) => {
    if (!/[\p{L}\p{N}]/u.test(character)) return
    const normalized = character.normalize('NFKC').toLocaleLowerCase()
    Array.from(normalized).forEach(value => {
      if (!/[\p{L}\p{N}]/u.test(value)) return
      characters.push(value)
      rawOffsets.push(visible.rawOffsets[index])
    })
  })
  return { text: characters.join(''), rawOffsets }
}
