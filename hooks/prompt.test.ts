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

test('未转义换行的译文也能按字面解析', {}, async () => {
  expect(
    parseTranslationResponse('{"translation":"第一行\n第二行"}'),
  ).toBe('第一行\n第二行')
})

test('未转义换行时仍能还原转义序列', {}, async () => {
  expect(
    parseTranslationResponse('{"translation":"他说 \\"好\\"\n然后走了"}'),
  ).toBe('他说 "好"\n然后走了')
})

test('未转义换行时仍能还原 unicode 转义', {}, async () => {
  expect(
    parseTranslationResponse('{"translation":"\\u4f60\\u597d\n再见"}'),
  ).toBe('你好\n再见')
})

test('代码围栏里未转义的换行也能解析', {}, async () => {
  expect(
    parseTranslationResponse(
      '```json\n{"translation":"第一行\n第二行"}\n```',
    ),
  ).toBe('第一行\n第二行')
})

test('内容里有未转义引号时不做猜测', {}, async () => {
  expect(
    parseTranslationResponse('{"translation":"他说 "好"\n然后走了"}'),
  ).toBeUndefined()
})

test('截断的 JSON 不做推测', {}, async () => {
  expect(parseTranslationResponse('{"translation":"第一行')).toBeUndefined()
})
