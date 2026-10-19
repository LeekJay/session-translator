import { expect, test } from 'claude-code/testing'
import {
  MAX_HEADER_LENGTH,
  buildAnswersRequest,
  buildQuestionsRequest,
  freeTextAnswers,
  parseQuestionsResponse,
  questionTexts,
  rewriteQuestions,
  translateAnswers,
} from './questions'

const QUESTIONS = [
  {
    question: 'Which library should we use?',
    header: 'Library',
    multiSelect: false,
    options: [
      {
        label: 'Vitest',
        description: 'Fast and Vite-native.',
        preview: 'vitest run',
      },
      { label: 'Jest', description: 'Widely used.' },
    ],
  },
]

test('按渲染顺序收集问题与选项文本，跳过预览', {}, async () => {
  expect(questionTexts(QUESTIONS)).toEqual([
    'Which library should we use?',
    'Library',
    'Vitest',
    'Fast and Vite-native.',
    'Jest',
    'Widely used.',
  ])
})

test('改写替换文本字段并保留结构和预览', {}, async () => {
  const rewritten = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    '测试库',
    '维特',
    '快且原生支持 Vite。',
    '杰斯特',
    '使用广泛。',
  ])

  expect(rewritten).toBeDefined()
  const question = rewritten?.[0] as Record<string, unknown>
  expect(question.question).toBe('用哪个测试库？')
  expect(question.header).toBe('测试库')
  expect(question.multiSelect).toBe(false)

  const options = question.options as Array<Record<string, unknown>>
  expect(options[0].label).toBe('维特')
  expect(options[0].description).toBe('快且原生支持 Vite。')
  expect(options[0].preview).toBe('vitest run')
  expect(options[1].label).toBe('杰斯特')
})

test('答案映射回原问题文本与英文标签', {}, async () => {
  const translated = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    '测试库',
    '维特',
    '快。',
    '杰斯特',
    '常用。',
  ]) as unknown[]

  const result = {
    questions: translated,
    answers: { '用哪个测试库？': '维特, 杰斯特' },
    annotations: { '用哪个测试库？': '备注' },
    response: '自由输入',
  }

  const back = translateAnswers(
    result,
    QUESTIONS,
    translated,
  ) as Record<string, unknown>

  expect(back.questions).toBe(QUESTIONS)
  expect(back.answers).toEqual({
    'Which library should we use?': 'Vitest, Jest',
  })
  expect(back.annotations).toEqual({ 'Which library should we use?': '备注' })
  expect(back.response).toBe('自由输入')
})

test('收集用户手输的自由答案，跳过选项标签', {}, async () => {
  const translated = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    '测试库',
    '维特',
    '快。',
    '杰斯特',
    '常用。',
  ]) as unknown[]

  const result = {
    questions: translated,
    answers: {
      '用哪个测试库？': '维特',
      'Which OS?': '我在 Windows 上开发，顺便看看 Linux',
    },
    annotations: { '用哪个测试库？': '再想想' },
    response: '能不能只用标准库？',
  }

  expect(freeTextAnswers(result, QUESTIONS, translated)).toEqual([
    '我在 Windows 上开发，顺便看看 Linux',
    '再想想',
    '能不能只用标准库？',
  ])
})

test('自由答案按整串翻译回填，不拆逗号', {}, async () => {
  const translated = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    '测试库',
    '维特',
    '快。',
    '杰斯特',
    '常用。',
  ]) as unknown[]

  const source = '我在 Windows 上开发，顺便看看 Linux'
  const target = 'I develop on Windows, and also want to check Linux'

  const result = {
    questions: translated,
    answers: { '用哪个测试库？': '维特, 我在 Windows 上开发，顺便看看 Linux' },
    response: source,
  }

  const back = translateAnswers(
    result,
    QUESTIONS,
    translated,
    new Map([[source, target]]),
  ) as Record<string, unknown>

  expect(back.answers).toEqual({
    'Which library should we use?': `Vitest, ${target}`,
  })
  expect(back.response).toBe(target)
})

test('答案请求要求严格 JSON 且不限制长度', {}, async () => {
  const request = buildAnswersRequest(['我在 Windows 上开发'], 'en', '')
  expect(request.prompt).toBe('["我在 Windows 上开发"]')
  expect(request.system).toContain('English')
  expect(request.system).toContain('{"translations":[...]}')
  expect(request.system).not.toContain('at most')
})

test('译文数量对不上时不改写', {}, async () => {
  expect(rewriteQuestions(QUESTIONS, ['只有一项'])).toBeUndefined()
})

test('标题译文超长时保留原文', {}, async () => {
  const longHeader = '这是一个超过十二个字符的标题'
  expect(longHeader.length).toBeGreaterThan(MAX_HEADER_LENGTH)

  const rewritten = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    longHeader,
    '维特',
    '快。',
    '杰斯特',
    '常用。',
  ])

  const question = rewritten?.[0] as Record<string, unknown>
  expect(question.header).toBe('Library')
})

test('解析严格 JSON、代码围栏和坏响应', {}, async () => {
  expect(
    parseQuestionsResponse('{"translations":["甲","乙"]}'),
  ).toEqual(['甲', '乙'])
  expect(
    parseQuestionsResponse('```json\n{"translations":["甲"]}\n```'),
  ).toEqual(['甲'])
  expect(parseQuestionsResponse('not json')).toBeUndefined()
  expect(parseQuestionsResponse('{"translations":[]}')).toBeUndefined()
  expect(parseQuestionsResponse('{"translations":[1]}')).toBeUndefined()
})

test('请求要求严格 JSON 并限制长度', {}, async () => {
  const request = buildQuestionsRequest(['Hello', 'World'], 'zh', '')
  expect(request.prompt).toBe('["Hello","World"]')
  expect(request.system).toContain('Simplified Chinese')
  expect(request.system).toContain('{"translations":[...]}')
  expect(request.maxTokens).toBeGreaterThanOrEqual(4096)
})
