import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { uploadKnowledgeArchive } from '../src/knowledge-api.ts'

test('ZIP upload preserves Markdown and image relative paths', async () => {
  const zip = new JSZip()
  zip.file('guide/readme.md', '# 指南\n\n![流程](images/flow.png)')
  zip.file('guide/images/flow.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  zip.file('guide/raw.bin', Buffer.from([1, 2, 3]))
  const archive = Object.assign(await zip.generateAsync({ type: 'nodebuffer' }), { name: 'guide.zip' }) as unknown as File
  let requestBody: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({ documents: 1, attachments: 1, deduplicated: 0, skipped: 1 }), { status: 202, headers: { 'content-type': 'application/json' } })
  }
  try {
    const result = await uploadKnowledgeArchive('kb-1', archive, '产品资料', 'requirement')
    assert.deepEqual(result, { documents: 1, attachments: 1, deduplicated: 0, skipped: 1 })
    assert.equal((requestBody?.documents as { logicalPath: string }[])[0].logicalPath, '产品资料/guide/readme.md')
    assert.equal((requestBody?.attachments as { logicalPath: string }[])[0].logicalPath, '产品资料/guide/images/flow.png')
    assert.equal(requestBody?.skipped, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
