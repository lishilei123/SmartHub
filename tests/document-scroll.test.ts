import assert from 'node:assert/strict'
import test from 'node:test'
import { getActiveDocumentSectionKey, getClosestSourceLineIndex } from '../src/document-scroll.ts'

const sections = [
  { key: 'section-0', top: 120 },
  { key: 'section-1', top: 480 },
  { key: 'section-2', top: 920 },
]

test('uses the first section before the reading line reaches a heading', () => {
  assert.equal(getActiveDocumentSectionKey(sections, 0), 'section-0')
  assert.equal(getActiveDocumentSectionKey(sections, 119), 'section-0')
})

test('uses the last section at or above the reading line', () => {
  assert.equal(getActiveDocumentSectionKey(sections, 480), 'section-1')
  assert.equal(getActiveDocumentSectionKey(sections, 900), 'section-1')
  assert.equal(getActiveDocumentSectionKey(sections, 920), 'section-2')
  assert.equal(getActiveDocumentSectionKey(sections, 1400), 'section-2')
})

test('returns null when the document has no navigable sections', () => {
  assert.equal(getActiveDocumentSectionKey([], 300), null)
})

test('finds the rendered source block at or immediately before a Chunk line', () => {
  assert.equal(getClosestSourceLineIndex([1, 5, 12, 20], 12), 2)
  assert.equal(getClosestSourceLineIndex([1, 5, 12, 20], 18), 2)
  assert.equal(getClosestSourceLineIndex([5, 12], 1), 0)
  assert.equal(getClosestSourceLineIndex([], 10), -1)
})
