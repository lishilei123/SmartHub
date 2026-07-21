import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownDocument, resolveKnowledgeDocumentLink, resolveKnowledgeImage } from '../src/MarkdownDocument.tsx'
import { parseMarkdownOutline } from '../src/markdown-outline.ts'

function render(source: string, format: 'markdown' | 'text' = 'markdown') {
  return renderToStaticMarkup(createElement(MarkdownDocument, { source, format }))
}

test('renders GFM pipe tables as semantic tables', () => {
  const html = render('| 项目 | 内容 |\n| --- | :---: |\n| 产品名称 | SmartHub |')

  assert.equal((html.match(/<table/g) ?? []).length, 1)
  assert.match(html, /<thead>/)
  assert.match(html, /<tbody>/)
  assert.match(html, /<th[^>]*>项目<\/th>/)
  assert.match(html, /<th[^>]*>内容<\/th>/)
  assert.match(html, /<td[^>]*>产品名称<\/td>/)
  assert.match(html, /<td[^>]*>SmartHub<\/td>/)
  assert.doesNotMatch(html, />---</)
})

test('renders standard Markdown blocks structurally', () => {
  const html = render('# 标题\n\n- 一\n- 二\n\n> 引用\n\n```ts\nconst value = 1\n```')

  assert.match(html, /<h1>标题<\/h1>/)
  assert.equal((html.match(/<ul>/g) ?? []).length, 1)
  assert.equal((html.match(/<li>/g) ?? []).length, 2)
  assert.match(html, /<li>一<\/li>/)
  assert.match(html, /<li>二<\/li>/)
  assert.match(html, /<blockquote>\s*<p>引用<\/p>\s*<\/blockquote>/)
  assert.match(html, /<pre><code class="language-ts">const value = 1\n<\/code><\/pre>/)
})

test('adds anchors from the shared outline for every navigable heading', () => {
  const source = '# 标题\n\n## 第一节\n\n# 重新分级\n\n### 第二节'
  const outline = parseMarkdownOutline(source)
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { source, format: 'markdown', outline, activeSectionKey: 'section-1', anchorPrefix: 'preview-document' }))

  assert.deepEqual(outline.sections.map(section => section.title), ['第一节', '重新分级', '第二节'])
  assert.match(html, /<h2 id="preview-document-section-0" data-document-section-key="section-0" class="document-section-heading">第一节<\/h2>/)
  assert.match(html, /<h1 id="preview-document-section-1" data-document-section-key="section-1" class="document-section-heading active-document-section">重新分级<\/h1>/)
  assert.match(html, /<h3 id="preview-document-section-2" data-document-section-key="section-2" class="document-section-heading">第二节<\/h3>/)
})

test('excludes fenced code pseudo-headings and distinguishes duplicate headings', () => {
  const source = '# 标题\n\n```md\n# 不是标题\n## 也不是章节\n```\n\n## 重复\n\n## 重复'
  const outline = parseMarkdownOutline(source)
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { source, format: 'markdown', outline }))

  assert.deepEqual(outline.sections.map(section => [section.key, section.title]), [['section-0', '重复'], ['section-1', '重复']])
  assert.doesNotMatch(html, /不是标题.*data-document-section-key/)
  assert.match(html, /id="document-section-section-0" data-document-section-key="section-0"/)
  assert.match(html, /id="document-section-section-1" data-document-section-key="section-1"/)
})

test('keeps raw HTML inert and suppresses remote Markdown images', () => {
  const html = render('<script>alert(1)</script>\n\n![远程图片](https://example.invalid/tracker.png)')

  assert.doesNotMatch(html, /<script/)
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /md-image-placeholder/)
  assert.match(html, />远程图片<\/span>/)
})

test('resolves ZIP-local Markdown images against the document path', () => {
  assert.equal(resolveKnowledgeImage('kb 1', 'guide/intro/readme.md', '../images/flow chart.png'), 'http://127.0.0.1:8787/api/knowledge-bases/kb%201/files/guide/images/flow%20chart.png')
  assert.equal(resolveKnowledgeImage('kb-1', 'readme.md', '../../escape.png'), null)
  assert.equal(resolveKnowledgeImage('kb-1', 'readme.md', 'https://example.com/a.png'), null)
  const html = renderToStaticMarkup(createElement(MarkdownDocument, { source: '![流程](../images/flow.png)', format: 'markdown', knowledgeBaseId: 'kb-1', logicalPath: 'docs/readme.md' }))
  assert.match(html, /class="md-knowledge-image"/)
  assert.match(html, /\/api\/knowledge-bases\/kb-1\/files\/images\/flow.png/)
})

test('resolves relative Markdown links inside the knowledge base', () => {
  assert.equal(resolveKnowledgeDocumentLink('需求文档/需求文档.md', '第一期-%E9%9C%80%E6%B1%82.md'), '需求文档/第一期-需求.md')
  assert.equal(resolveKnowledgeDocumentLink('需求文档/子目录/说明.md', '../需求文档.md'), '需求文档/需求文档.md')
  assert.equal(resolveKnowledgeDocumentLink('需求文档/需求文档.md', 'https://example.com/a.md'), null)
  assert.equal(resolveKnowledgeDocumentLink('需求文档/需求文档.md', '/absolute.md'), null)
})

test('renders TXT source literally without parsing table syntax', () => {
  const source = '| 项目 | 内容 |\n| --- | --- |\n| 产品名称 | SmartHub |'
  const html = render(source, 'text')

  assert.match(html, /<pre class="plain-text-document">/)
  assert.match(html, /\| 项目 \| 内容 \|/)
  assert.doesNotMatch(html, /<table/)
})
