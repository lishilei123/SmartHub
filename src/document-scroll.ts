export type DocumentSectionPosition = {
  key: string
  top: number
}

export function getActiveDocumentSectionKey(sections: DocumentSectionPosition[], readingLine: number) {
  if (!sections.length) return null

  let activeKey = sections[0].key
  for (const section of sections) {
    if (section.top > readingLine) break
    activeKey = section.key
  }
  return activeKey
}

export function getClosestSourceLineIndex(lines: number[], targetLine: number) {
  if (!lines.length) return -1
  let closest = 0
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] > targetLine) break
    closest = index
  }
  return closest
}
