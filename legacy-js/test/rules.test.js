import test from 'node:test'
import assert from 'node:assert/strict'
import { extractCandidates } from '../lib/ingest/rules.js'
import { extractMessageText, collapseLine } from '../lib/ingest/text.js'

test('extracts Chinese "我主要用 X"', () => {
  const hits = extractCandidates('我主要用 TypeScript，平时也写一点 Python。')
  assert.ok(hits.length >= 1, JSON.stringify(hits))
  assert.ok(hits.some((h) => h.content === 'User mainly uses TypeScript'))
  assert.equal(hits[0].kind, 'profile')
  assert.equal(hits[0].confidence, 0.9)
})

test('extracts English "I mainly use X"', () => {
  const hits = extractCandidates('I mainly use Rust for my backend.')
  assert.ok(hits.some((h) => h.content.includes('Rust')), JSON.stringify(hits))
})

test('extracts "I prefer X editor"', () => {
  const hits = extractCandidates('I prefer Neovim as my editor.')
  assert.ok(hits.length >= 1, JSON.stringify(hits))
})

test('does not extract from generic project talk or questions', () => {
  assert.deepEqual(extractCandidates('帮我看看这个报错'), [])
  assert.deepEqual(extractCandidates('这个项目用什么框架比较合适？'), [])
  assert.deepEqual(extractCandidates('Could you explain how this works?'), [])
  assert.deepEqual(extractCandidates('我用的就是那个'), [])
})

test('collapses whitespace and bounds length', () => {
  assert.equal(collapseLine('  a\n  b\t c '), 'a b c')
  assert.ok(collapseLine('x'.repeat(5000), 100).endsWith('…'))
})

test('extractMessageText tolerates block shapes', () => {
  const text = extractMessageText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'reasoning', text: 'skip me' },
      { type: 'tool-result', content: [{ type: 'text', text: 'nested' }] },
      { type: 'image', image: 'data:image' },
      { type: 'weird-unknown' },
    ],
  })
  assert.equal(text, 'hello\nnested')
  assert.equal(extractMessageText(null), '')
  assert.equal(extractMessageText({}), '')
})
