import type { ModelCompleteResult } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import {
  type Options,
  describeCompletion,
  describeSonnet,
  formatConfigRows,
  needsSonnet,
  parseTranslatorCommand,
  readOptions,
} from './commands'

const INITIAL: Options = readOptions({})

const CURRENT: Options = {
  translateInput: true,
  inputLanguage: 'en',
  translateOutput: true,
  outputLanguage: 'zh',
  model: 'sonnet',
  translationRules: 'Keep terms intact.',
}

const USAGE = {
  input_tokens: 12,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

test('parseTranslatorCommand 解析 status、on、off 与 reset', {}, async () => {
  expect(parseTranslatorCommand('', CURRENT, INITIAL)).toEqual({
    kind: 'status',
  })
  expect(parseTranslatorCommand('   status  ', CURRENT, INITIAL)).toEqual({
    kind: 'status',
  })

  expect(parseTranslatorCommand('off', CURRENT, INITIAL)).toEqual({
    kind: 'update',
    next: {
      ...CURRENT,
      translateInput: false,
      translateOutput: false,
    },
    reply: '已更新：translateInput=false, translateOutput=false',
  })

  const disabled: Options = {
    ...CURRENT,
    translateInput: false,
    translateOutput: false,
  }
  expect(parseTranslatorCommand('on', disabled, INITIAL)).toEqual({
    kind: 'update',
    next: {
      ...disabled,
      translateInput: true,
      translateOutput: true,
    },
    reply: '已更新：translateInput=true, translateOutput=true',
  })

  expect(parseTranslatorCommand('reset', CURRENT, INITIAL)).toEqual({
    kind: 'reset',
    next: INITIAL,
    reply:
      '已重置：translateInput=true，inputLanguage=en，translateOutput=true，outputLanguage=zh，model=haiku，translationRules=(empty)',
  })
})

test('parseTranslatorCommand 解析 input、output、model、rules 与非法指令', {}, async () => {
  expect(parseTranslatorCommand('input ja', CURRENT, INITIAL)).toEqual({
    kind: 'update',
    next: { ...CURRENT, inputLanguage: 'ja' },
    reply: '已更新：inputLanguage=ja',
  })

  const invalidInput = parseTranslatorCommand('input es', CURRENT, INITIAL)
  expect(invalidInput.kind).toBe('reply')
  if (invalidInput.kind === 'reply') {
    expect(invalidInput.text).toContain('usage: /translator')
  }

  expect(parseTranslatorCommand('output fr', CURRENT, INITIAL)).toEqual({
    kind: 'update',
    next: { ...CURRENT, outputLanguage: 'fr' },
    reply: '已更新：outputLanguage=fr',
  })

  const invalidOutput = parseTranslatorCommand('output', CURRENT, INITIAL)
  expect(invalidOutput.kind).toBe('reply')
  if (invalidOutput.kind === 'reply') {
    expect(invalidOutput.text).toContain('usage: /translator')
  }

  expect(parseTranslatorCommand('model opus', CURRENT, INITIAL)).toEqual({
    kind: 'update',
    next: { ...CURRENT, model: 'opus' },
    reply: '已更新：model=opus',
  })

  const emptyModel = parseTranslatorCommand('model   ', CURRENT, INITIAL)
  expect(emptyModel.kind).toBe('reply')
  if (emptyModel.kind === 'reply') {
    expect(emptyModel.text).toContain('usage: /translator')
  }

  expect(
    parseTranslatorCommand('rules  Keep API names. ', CURRENT, INITIAL),
  ).toEqual({
    kind: 'update',
    next: { ...CURRENT, translationRules: 'Keep API names.' },
    reply: '已更新：translationRules=Keep API names.',
  })

  expect(parseTranslatorCommand('rules   ', CURRENT, INITIAL)).toEqual({
    kind: 'update',
    next: { ...CURRENT, translationRules: '' },
    reply: '已清空：translationRules',
  })

  const unknownVerb = parseTranslatorCommand('unknown arg', CURRENT, INITIAL)
  expect(unknownVerb.kind).toBe('reply')
  if (unknownVerb.kind === 'reply') {
    expect(unknownVerb.text).toContain('usage: /translator')
  }
})

test('formatConfigRows 过滤非本插件配置行并格式化匹配项', {}, async () => {
  expect(formatConfigRows([])).toBe('config rows: none')
  expect(
    formatConfigRows([
      { key: 'other-plugin.model', value: 'opus' },
      { key: 'theme', value: 'dark' },
    ]),
  ).toBe('config rows: none')

  expect(
    formatConfigRows([
      { key: 'other-plugin.model', value: 'opus' },
      { key: 'session-translator.model', value: 'haiku' },
      { key: 'session-translator.translateInput', value: false },
    ]),
  ).toBe(
    [
      'config rows:',
      'session-translator.model="haiku"',
      'session-translator.translateInput=false',
    ].join('\n'),
  )
})

test('describeCompletion、describeSonnet 与 needsSonnet 处理回答与错误状态', {}, async () => {
  const chineseReply: ModelCompleteResult = {
    isAnswered: true,
    text: '{"translation":"你好，世界"}',
    usage: USAGE,
  }
  expect(needsSonnet(chineseReply)).toBe(false)
  expect(describeCompletion('haiku', chineseReply)).toBe(
    [
      'model: haiku',
      'reply: {"translation":"你好，世界"}',
      'usage: out=5, in=12',
    ].join('\n'),
  )
  expect(describeSonnet(chineseReply)).toBe(
    ['sonnet: {"translation":"你好，世界"}', 'sonnet usage: out=5, in=12'].join(
      '\n',
    ),
  )

  const englishReply: ModelCompleteResult = {
    isAnswered: true,
    text: 'Hello world',
    usage: USAGE,
  }
  expect(needsSonnet(englishReply)).toBe(true)

  const emptyReply: ModelCompleteResult = {
    isAnswered: false,
    reason: 'empty-reply',
    usage: USAGE,
  }
  expect(needsSonnet(emptyReply)).toBe(true)
  expect(describeCompletion('haiku', emptyReply)).toBe(
    ['model: haiku', 'reason: empty-reply', 'usage: out=5, in=12'].join('\n'),
  )
  expect(describeSonnet(emptyReply)).toBe(
    ['sonnet reason: empty-reply', 'sonnet usage: out=5, in=12'].join('\n'),
  )

  const apiError: ModelCompleteResult = {
    isAnswered: false,
    reason: 'api-error',
    error: 'rate_limit',
    status: 429,
    usage: USAGE,
  }
  expect(needsSonnet(apiError)).toBe(true)
  expect(describeCompletion('haiku', apiError)).toBe(
    [
      'model: haiku',
      'reason: api-error (rate_limit, status=429)',
      'usage: out=5, in=12',
    ].join('\n'),
  )
  expect(describeSonnet(apiError)).toBe(
    [
      'sonnet reason: api-error (rate_limit, status=429)',
      'sonnet usage: out=5, in=12',
    ].join('\n'),
  )

  const networkError: ModelCompleteResult = {
    isAnswered: false,
    reason: 'api-error',
    error: 'server_error',
    status: null,
    usage: USAGE,
  }
  expect(describeCompletion('haiku', networkError)).toBe(
    [
      'model: haiku',
      'reason: api-error (server_error, status=none)',
      'usage: out=5, in=12',
    ].join('\n'),
  )
})
