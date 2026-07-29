import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TechnicalDocumentViewer, type TechnicalDocument } from '../src/TechnicalDocumentViewer.tsx'

function render(document: TechnicalDocument) {
  return renderToStaticMarkup(createElement(TechnicalDocumentViewer, { document, onClose: () => undefined }))
}

test('renders a bounded fixed-source reader with an accessible close action', () => {
  const html = render({ assetVersionId: 'asset-version-1', title: '技术设计.md', content: '# 标题\n正文' })

  assert.match(html, /class="fixed-document"/)
  assert.match(html, /aria-label="关闭固定原文"/)
  assert.match(html, /从文档顶部打开/)
  assert.match(html, /data-source-line="1"/)
  assert.match(html, /data-source-line="2"/)
})

test('marks the complete Evidence line range without changing the fixed asset version', () => {
  const html = render({
    assetVersionId: 'asset-version-1',
    title: '技术设计.md',
    content: '第一行\n第二行\n第三行\n第四行',
    evidence: {
      id: 'evidence-1',
      sourceKind: 'technical_design',
      assetId: 'asset-1',
      assetVersionId: 'asset-version-1',
      chunkId: 'chunk-1',
      contentSha256: 'hash-1',
      headingPath: ['接口设计'],
      quote: '第二行\n第三行',
      startLine: 2,
      endLine: 3,
    },
  })

  assert.match(html, /asset-version-1 · L2-3/)
  assert.equal((html.match(/class="hit"/g) ?? []).length, 2)
  assert.match(html, /class="hit" data-source-line="2"/)
  assert.match(html, /class="hit" data-source-line="3"/)
  assert.doesNotMatch(html, /class="hit" data-source-line="4"/)
})
