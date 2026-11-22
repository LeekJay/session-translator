import { expect, test } from 'claude-code/testing'
import { isUsableTranslation } from './languages'
import {
  cacheKey,
  finalizeTranslation,
  isSlashCommand,
  MAX_CACHE_CHARS,
  prepareTranslation,
  pruneCache,
  questionsCacheKey,
  translationSignature,
} from './translate'

type TestCache = Record<
  string,
  | { status: 'translated'; text: string }
  | { status: 'failed'; reason: string }
>

const BASE = {
  inputLanguage: 'en' as const,
  outputLanguage: 'zh' as const,
  model: 'haiku',
  translationRules: '',
  promptVersion: 'V1',
}

test('签名包含提示词版本', {}, async () => {
  expect(translationSignature({ ...BASE, promptVersion: 'V2' })).not.toBe(
    translationSignature(BASE),
  )
})

test('缓存键区分请求类型', {}, async () => {
  const signature = translationSignature(BASE)
  expect(cacheKey(signature, 'zh', 'output', '原文')).not.toBe(
    cacheKey(signature, 'zh', 'input', '原文'),
  )
})

test('问题提示词版本不同时问答缓存键不同', {}, async () => {
  const signature = translationSignature(BASE)
  const texts = ['Choose a fruit', 'Apple', 'Banana']
  expect(questionsCacheKey(signature, 'zh', 'Q1', texts)).not.toBe(
    questionsCacheKey(signature, 'zh', 'Q2', texts),
  )
})

test('问题提示词版本相同时问答缓存键稳定', {}, async () => {
  const signature = translationSignature(BASE)
  const texts = ['Choose a fruit', 'Apple', 'Banana']
  expect(questionsCacheKey(signature, 'zh', 'Q1', texts)).toBe(
    questionsCacheKey(signature, 'zh', 'Q1', texts),
  )
})

test('问答缓存键与回复缓存键不共用', {}, async () => {
  const signature = translationSignature(BASE)
  const texts = ['Choose a fruit']
  const text = `Q1\u0000tool-questions\u0000${JSON.stringify(texts)}`
  expect(questionsCacheKey(signature, 'zh', 'Q1', texts)).not.toBe(
    cacheKey(signature, 'zh', 'output', text),
  )
})

test('满额后淘汰最旧的条目', {}, async () => {
  const cache: Record<string, { status: 'translated'; text: string }> = {}
  for (let index = 0; index < 302; index += 1) {
    cache['k' + index] = { status: 'translated', text: String(index) }
  }
  const pruned = pruneCache(cache)
  expect(Object.keys(pruned).length).toBe(300)
  expect(pruned['k0']).toBeUndefined()
  expect(pruned['k301']).toBeDefined()
})

test('条目数和字符数都没超限时缓存原样保留', {}, async () => {
  const cache: TestCache = {}
  for (let index = 0; index < 10; index += 1) {
    cache['k' + index] = { status: 'translated', text: `短译文 ${index}` }
  }
  expect(pruneCache(cache)).toBe(cache)
})

test('总字符数超过上限时淘汰最旧的条目', {}, async () => {
  const cache: TestCache = {}
  const longText = '字'.repeat(100_000)
  // 12 × 10 万 = 120 万字符，只保留最新的 10 条（正好 100 万）。
  for (let index = 0; index < 12; index += 1) {
    cache['k' + index] = { status: 'translated', text: longText }
  }
  const pruned = pruneCache(cache)
  expect(Object.keys(pruned).length).toBe(10)
  expect(pruned['k0']).toBeUndefined()
  expect(pruned['k1']).toBeUndefined()
  expect(pruned['k2']).toBeDefined()
  expect(pruned['k11']).toBeDefined()
})

test('失败条目不计入字符上限但仍保留', {}, async () => {
  const cache: TestCache = {}
  const longText = '字'.repeat(100_000)
  for (let index = 0; index < 10; index += 1) {
    cache['t' + index] = { status: 'translated', text: longText }
  }
  // 失败原因再长也不占字符预算；若计入会误删最旧的译文。
  cache['f0'] = { status: 'failed', reason: 'x'.repeat(MAX_CACHE_CHARS) }
  const pruned = pruneCache(cache)
  expect(Object.keys(pruned).length).toBe(11)
  expect(pruned['t0']).toBeDefined()
  expect(pruned['f0']).toBeDefined()
})

test('条目数和字符数上限同时生效时按更严格的结果淘汰', {}, async () => {
  const cache: TestCache = {}
  for (let index = 0; index < 5; index += 1) {
    cache['s' + index] = { status: 'translated', text: '短' }
  }
  const longText = '字'.repeat(4000)
  for (let index = 0; index < 300; index += 1) {
    cache['l' + index] = { status: 'translated', text: longText }
  }
  const pruned = pruneCache(cache)
  // 305 条先按条数删 5 条短译文，剩 120 万字符再删最旧的 50 条长译文。
  expect(Object.keys(pruned).length).toBe(250)
  expect(pruned['s0']).toBeUndefined()
  expect(pruned['l49']).toBeUndefined()
  expect(pruned['l50']).toBeDefined()
})

test('单条译文超过字符上限时也会被淘汰', {}, async () => {
  const cache: TestCache = {
    big: { status: 'translated', text: '字'.repeat(MAX_CACHE_CHARS + 1) },
  }
  expect(Object.keys(pruneCache(cache)).length).toBe(0)
})

test('多行译文未转义换行时仍算翻译成功', {}, async () => {
  const prepared = prepareTranslation({
    text: 'First line of the reply.\nSecond line.',
    target: 'zh',
    translationRules: '',
    model: 'haiku',
    kind: 'output',
  })
  const entry = finalizeTranslation(prepared, {
    isAnswered: true,
    text: '{"translation":"回复第一行\n回复第二行"}',
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  expect(entry.status).toBe('translated')
  expect(entry.status === 'translated' ? entry.text : '').toBe(
    '回复第一行\n回复第二行',
  )
})

test('长英文译为较短中文时不误判为截断，严重截断仍失败', {}, async () => {
  const sourceLength = 480
  const normalZh = '这是一段正常的中文翻译内容。'.repeat(9) // 126 chars
  const truncatedZh = '这是一段被严重截断的中文翻译内容。'.repeat(2).slice(0, 30)

  expect(isUsableTranslation(normalZh, 'zh', sourceLength)).toBe(true)
  expect(isUsableTranslation(truncatedZh, 'zh', sourceLength)).toBe(false)
})

test('斜杠命令仅匹配字母开头的命令名', {}, async () => {
  expect(isSlashCommand('/help')).toBe(true)
  expect(isSlashCommand('/pstack:poteto-mode')).toBe(true)
  expect(isSlashCommand('/123 你好')).toBe(false)
  expect(isSlashCommand('/-flag 这是什么')).toBe(false)
})
