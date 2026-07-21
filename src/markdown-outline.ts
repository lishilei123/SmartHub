import { toString } from 'mdast-util-to-string'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type { Root } from 'mdast'

export type MarkdownSection = {
  key: string
  title: string
  depth: number
  sourceOffset: number
}

export type MarkdownOutline = {
  title?: string
  sections: MarkdownSection[]
}

export const emptyMarkdownOutline: MarkdownOutline = { sections: [] }

export function parseMarkdownOutline(source: string): MarkdownOutline {
  const headings: Omit<MarkdownSection, 'key'>[] = []
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root

  visit(tree, 'heading', node => {
    const sourceOffset = node.position?.start.offset
    if (typeof sourceOffset !== 'number') return
    headings.push({ title: toString(node).trim(), depth: node.depth, sourceOffset })
  })

  const [title, ...sections] = headings
  return {
    title: title?.title || undefined,
    sections: sections.map((section, index) => ({ ...section, key: `section-${index}` })),
  }
}
