import { expect, test } from 'claude-code/testing'
import type { TranslationCache } from '../types'
import {
  cacheKey,
  finalizeTranslation,
  persistableCache,
  prepareTranslation,
  pruneCache,
  translationSignature,
} from './translate'

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

test('持久化时丢弃失败条目', {}, async () => {
  const cache: TranslationCache = {
    translated: { status: 'translated', text: '好' },
    failed: { status: 'failed', reason: 'malformed-response: x' },
  }
  expect(persistableCache(cache)).toEqual({
    translated: { status: 'translated', text: '好' },
  })
})

test('满额后淘汰最旧的条目', {}, async () => {
  const cache: TranslationCache = {}
  for (let index = 0; index < 302; index += 1) {
    cache['k' + index] = { status: 'translated', text: String(index) }
  }
  const pruned = pruneCache(cache)
  expect(Object.keys(pruned).length).toBe(300)
  expect(pruned['k0']).toBeUndefined()
  expect(pruned['k301']).toBeDefined()
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
