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

test('对象形态的备注保留结构，只翻译 notes', {}, async () => {
  const translated = rewriteQuestions(QUESTIONS, [
    '用哪个测试库？',
    '测试库',
    '维特',
    '快。',
    '杰斯特',
    '常用。',
  ]) as unknown[]

  const note = '我在 Windows 上开发'
  const noteEnglish = 'I develop on Windows'
  const result = {
    questions: translated,
    annotations: {
      '用哪个测试库？': {
        notes: note,
        preview: 'vitest run',
        unanswered: 'dismissed',
      },
    },
  }

  expect(freeTextAnswers(result, QUESTIONS, translated)).toEqual([note])

  const back = translateAnswers(
    result,
    QUESTIONS,
    translated,
    new Map([[note, noteEnglish]]),
  ) as Record<string, unknown>

  expect(back.annotations).toEqual({
    'Which library should we use?': {
      notes: noteEnglish,
      preview: 'vitest run',
      unanswered: 'dismissed',
    },
  })
})

test('两句的选项译名相同时各按本句标签还原', {}, async () => {
  const questions = [
    {
      question: 'Enable feature?',
      options: [{ label: 'Enable' }, { label: 'Disable' }],
    },
    {
      question: 'Turn it on?',
      options: [{ label: 'Turn on' }, { label: 'Turn off' }],
    },
  ]
  const translated = rewriteQuestions(questions, [
    '开启功能？',
    '开启',
    '关闭',
    '要打开吗？',
    '开启',
    '关闭',
  ]) as unknown[]

  const result = {
    questions: translated,
    answers: {
      '开启功能？': '开启',
      '要打开吗？': '开启',
    },
    annotations: {
      '开启功能？': {
        notes: '先备份',
        preview: 'enable --now',
        unanswered: 'dismissed',
      },
    },
    response: '开启',
  }

  // response 的“开启”在两道题里指向不同原文，不能当标签，按自由文本收集。
  expect(freeTextAnswers(result, questions, translated)).toEqual([
    '先备份',
    '开启',
  ])

  const back = translateAnswers(
    result,
    questions,
    translated,
    new Map([['先备份', 'back up first']]),
  ) as Record<string, unknown>

  expect(back.answers).toEqual({
    'Enable feature?': 'Enable',
    'Turn it on?': 'Turn on',
  })
  expect(back.annotations).toEqual({
    'Enable feature?': {
      notes: 'back up first',
      preview: 'enable --now',
      unanswered: 'dismissed',
    },
  })
  // 歧义标签不参与合并映射，response 不会被错绑到某一道题。
  expect(back.response).toBe('开启')
})

test('无问题归属的 response 不会被跨问题重名标签错绑', {}, async () => {
  const questions = [
    {
      question: 'Enable feature?',
      options: [{ label: 'Enable' }, { label: 'Disable' }],
    },
    {
      question: 'Turn it on?',
      options: [{ label: 'Turn on' }, { label: 'Turn off' }],
    },
  ]
  const translated = rewriteQuestions(questions, [
    '开启功能？',
    '开启',
    '关闭',
    '要打开吗？',
    '开启',
    '关闭',
  ]) as unknown[]

  const result = {
    questions: translated,
    answers: { '开启功能？': '开启', '要打开吗？': '开启' },
    response: '开启',
  }

  const back = translateAnswers(
    result,
    questions,
    translated,
  ) as Record<string, unknown>
  expect(back.answers).toEqual({
    'Enable feature?': 'Enable',
    'Turn it on?': 'Turn on',
  })
  expect(back.response).toBe('开启')

  const backWithFreeText = translateAnswers(
    result,
    questions,
    translated,
    new Map([['开启', 'Enabled']]),
  ) as Record<string, unknown>
  expect(backWithFreeText.answers).toEqual({
    'Enable feature?': 'Enable',
    'Turn it on?': 'Turn on',
  })
  expect(backWithFreeText.response).toBe('Enabled')
})

test('同一题的两个选项译名相同时不改写', {}, async () => {
  const questions = [
    {
      question: 'Pick one',
      options: [{ label: 'Enable' }, { label: 'Start' }],
    },
  ]

  expect(rewriteQuestions(questions, ['选一个', '开启', '开启'])).toBeUndefined()
})

test('两道题的问题文本译成同一句时不改写', {}, async () => {
  const questions = [
    {
      question: 'Enable feature?',
      options: [{ label: 'Enable' }, { label: 'Disable' }],
    },
    {
      question: 'Turn it on?',
      options: [{ label: 'Turn on' }, { label: 'Turn off' }],
    },
  ]

  expect(
    rewriteQuestions(questions, [
      '同一个问题？',
      '开启',
      '关闭',
      '同一个问题？',
      '打开',
      '关掉',
    ]),
  ).toBeUndefined()
})

test('冲突的选项译名按自由文本还原，不错绑到后一个选项', {}, async () => {
  const questions = [
    {
      question: 'Pick one',
      options: [{ label: 'Enable' }, { label: 'Start' }],
    },
  ]
  // 绕过 rewriteQuestions 的重名检查，直接构造冲突译文。
  const translated = [
    {
      question: '选一个',
      options: [{ label: '开启' }, { label: '开启' }],
    },
  ]
  const result = {
    questions: translated,
    answers: { '选一个': '开启' },
  }

  const plain = translateAnswers(
    result,
    questions,
    translated,
  ) as Record<string, unknown>
  expect(plain.answers).toEqual({ 'Pick one': '开启' })

  const restored = translateAnswers(
    result,
    questions,
    translated,
    new Map([['开启', 'Switched on']]),
  ) as Record<string, unknown>
  expect(restored.answers).toEqual({ 'Pick one': 'Switched on' })
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

const MULTI_QUESTIONS = [
  {
    question: 'Which?',
    multiSelect: true,
    options: [{ label: 'Keep, always' }, { label: 'Drop' }],
  },
]

const MULTI_TRANSLATIONS = ['哪个？', '保留, 永远', '放弃']

function translatedMulti(): unknown[] {
  return rewriteQuestions(MULTI_QUESTIONS, MULTI_TRANSLATIONS) as unknown[]
}

test('多选答案里含逗号的引号标签解码后映射回原标签', {}, async () => {
  const translated = translatedMulti()
  const result = {
    questions: translated,
    answers: { '哪个？': '"保留, 永远", 放弃' },
  }

  expect(freeTextAnswers(result, MULTI_QUESTIONS, translated)).toEqual([])

  const back = translateAnswers(
    result,
    MULTI_QUESTIONS,
    translated,
  ) as Record<string, unknown>

  expect(back.answers).toEqual({ 'Which?': '"Keep, always", Drop' })
})

test('多选答案里转义引号的标签能解码并重新编码', {}, async () => {
  const questions = [
    {
      question: 'Which?',
      multiSelect: true,
      options: [{ label: 'Say "hi"' }, { label: 'Drop' }],
    },
  ]
  const translated = rewriteQuestions(questions, [
    '哪个？',
    '说 "嗨"',
    '放弃',
  ]) as unknown[]

  const result = {
    questions: translated,
    answers: { '哪个？': `${JSON.stringify('说 "嗨"')}, 放弃` },
  }

  expect(freeTextAnswers(result, questions, translated)).toEqual([])

  const back = translateAnswers(
    result,
    questions,
    translated,
  ) as Record<string, unknown>

  expect(back.answers).toEqual({
    'Which?': `${JSON.stringify('Say "hi"')}, Drop`,
  })
})

test('多选自由文本含 ASCII 逗号时整段翻译并加引号', {}, async () => {
  const translated = translatedMulti()

  const source = 'Windows, Linux'
  const target = 'Windows, macOS'
  const result = {
    questions: translated,
    answers: {
      '哪个？': `${JSON.stringify('保留, 永远')}, ${JSON.stringify(source)}`,
    },
  }

  expect(freeTextAnswers(result, MULTI_QUESTIONS, translated)).toEqual([source])

  const back = translateAnswers(
    result,
    MULTI_QUESTIONS,
    translated,
    new Map([[source, target]]),
  ) as Record<string, unknown>

  expect(back.answers).toEqual({
    'Which?': `${JSON.stringify('Keep, always')}, ${JSON.stringify(target)}`,
  })
})

test('多选答案的相邻自由片段分别翻译和回写', {}, async () => {
  const translated = translatedMulti()
  const answer = '"甲, 乙", 丙'
  const result = { questions: translated, answers: { '哪个？': answer } }

  expect(freeTextAnswers(result, MULTI_QUESTIONS, translated)).toEqual([
    '甲, 乙',
    '丙',
  ])

  const back = translateAnswers(
    result,
    MULTI_QUESTIONS,
    translated,
  ) as Record<string, unknown>

  // 两个片段各自加引号，边界不会被合并成一个片段。
  expect(back.answers).toEqual({ 'Which?': answer })
})

test('多选答案里的坏引号整段回退为自由文本', {}, async () => {
  const translated = translatedMulti()

  // 前面的 放弃 是合法标签；坏引号让整串回退，不能只还原前半段。
  const broken = '放弃, "坏"尾巴'
  const result = { questions: translated, answers: { '哪个？': broken } }

  expect(freeTextAnswers(result, MULTI_QUESTIONS, translated)).toEqual([broken])

  const back = translateAnswers(
    result,
    MULTI_QUESTIONS,
    translated,
    new Map([[broken, 'Drop, broken tail']]),
  ) as Record<string, unknown>

  expect(back.answers).toEqual({ 'Which?': '"Drop, broken tail"' })
})

test('单选答案不按多选串联格式解码', {}, async () => {
  const questions = [
    {
      question: 'Which?',
      multiSelect: false,
      options: [{ label: 'Keep, always' }, { label: 'Drop' }],
    },
  ]
  const translated = rewriteQuestions(questions, [
    '哪个？',
    '保留, 永远',
    '放弃',
  ]) as unknown[]

  const raw = '"hello, world", other'
  const result = { questions: translated, answers: { '哪个？': raw } }

  expect(freeTextAnswers(result, questions, translated)).toEqual([raw])

  const back = translateAnswers(
    result,
    questions,
    translated,
  ) as Record<string, unknown>

  expect(back.answers).toEqual({ 'Which?': raw })
})

test('备注按整段原文保留，不按多选答案解码或做标签映射', {}, async () => {
  const translated = translatedMulti()
  const notes = [
    '他说, "好", 然后停',
    '"保留, 永远", 然后停',
    '  他说, "好"  ',
    '放弃',
  ]

  for (const note of notes) {
    const result = {
      questions: translated,
      annotations: {
        '哪个？': { notes: note, preview: 'keep', unanswered: 'dismissed' },
      },
    }

    expect(freeTextAnswers(result, MULTI_QUESTIONS, translated)).toEqual([note])

    const restored = (
      translateAnswers(
        result,
        MULTI_QUESTIONS,
        translated,
      ) as Record<string, unknown>
    ).annotations
    expect(restored).toEqual({
      'Which?': { notes: note, preview: 'keep', unanswered: 'dismissed' },
    })

    const translatedBack = (
      translateAnswers(
        result,
        MULTI_QUESTIONS,
        translated,
        new Map([[note, 'translated note']]),
      ) as Record<string, unknown>
    ).annotations
    expect(translatedBack).toEqual({
      'Which?': {
        notes: 'translated note',
        preview: 'keep',
        unanswered: 'dismissed',
      },
    })
  }
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

test('两个请求都把附加规则放在 system 末尾', {}, async () => {
  const rules = '  Use an informal tone.  '
  for (const build of [buildQuestionsRequest, buildAnswersRequest]) {
    const lines = build(['Hello'], 'zh', rules).system.split('\n')
    expect(lines[lines.length - 2]).toBe('Additional rules:')
    expect(lines[lines.length - 1]).toBe('Use an informal tone.')
  }
})
