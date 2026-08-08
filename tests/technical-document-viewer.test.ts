import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TechnicalDocumentViewer, type TechnicalDocument } from '../src/TechnicalDocumentViewer.tsx'

function render(document: TechnicalDocument) {
  return renderToStaticMarkup(createElement(TechnicalDocumentViewer, { document, onClose: () => undefined }))
}

test('renders fixed Markdown as a document with an accessible close action', () => {
  const html = render({ assetVersionId: 'asset-version-1', title: '技术设计.md', content: '# 标题\n\n| 项目 | 内容 |\n| --- | --- |\n| 系统 | SmartHub |' })

  assert.match(html, /class="rr-source-document"/)
  assert.match(html, /aria-label="关闭固定原文定位"/)
  assert.match(html, /只读固定版本/)
  assert.match(html, /<h1[^>]*>标题<\/h1>/)
  assert.match(html, /<table class="md-table">/)
  assert.doesNotMatch(html, /data-source-line=/)
})

test('highlights the rendered Markdown block intersecting the fixed Evidence range', () => {
  const html = render({
    assetVersionId: 'asset-version-1',
    title: '技术设计.md',
    content: '# 标题\n\n## 接口设计\n第二行\n第三行\n\n## 其他\n第四行',
    evidence: {
      id: 'evidence-1',
      sourceKind: 'technical_design',
      assetId: 'asset-1',
      assetVersionId: 'asset-version-1',
      chunkId: 'chunk-1',
      contentSha256: 'hash-1',
      headingPath: ['接口设计'],
      quote: '第二行\n第三行',
      startLine: 4,
      endLine: 5,
    },
  })

  assert.match(html, /asset-version-1/)
  assert.match(html, /L4-5/)
  assert.match(html, /已定位固定 Evidence/)
  assert.equal((html.match(/technical-evidence-hit/g) ?? []).length, 1)
  assert.match(html, /<p[^>]*class="technical-evidence-hit"[^>]*>第二行\n第三行<\/p>/)
  assert.doesNotMatch(html, /<h2[^>]*class="technical-evidence-hit"[^>]*>其他<\/h2>/)
})
