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
