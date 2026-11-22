import { expect, test } from 'claude-code/testing'
import { parseTranslationResponse } from './prompt'

test('带 json 标记的代码围栏也能解析', {}, async () => {
  expect(
    parseTranslationResponse('\u0060\u0060\u0060json\n{"translation":"你好"}\n\u0060\u0060\u0060'),
  ).toBe('你好')
})

test('不带语言标记的代码围栏也能解析', {}, async () => {
  expect(
    parseTranslationResponse('\u0060\u0060\u0060\n{"translation":"hi"}\n\u0060\u0060\u0060'),
  ).toBe('hi')
})

test('多余字段不影响解析', {}, async () => {
  expect(
    parseTranslationResponse('{"translation":"hi","note":"x"}'),
  ).toBe('hi')
})

test('没有译文或类型不对时返回 undefined', {}, async () => {
  expect(parseTranslationResponse('not json')).toBeUndefined()
  expect(parseTranslationResponse('{"translation":1}')).toBeUndefined()
  expect(parseTranslationResponse('[]')).toBeUndefined()
})
