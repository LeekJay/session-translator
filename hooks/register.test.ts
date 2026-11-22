import { expect, mock, test } from 'claude-code/testing'
import type {
  On,
  PromptOrigin,
  RenderElement,
  RenderInput,
} from 'claude-code'
import { PROMPT_TAG } from './prompt'
import {
  applyStoredSettings,
  describeSettings,
  scheduleTranslation,
  SETTING_KEYS,
  settingsPayload,
} from './register'
import type { Options } from './register'
import { cacheKey, translationSignature } from './translate'

const USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

const SOURCE = /SOURCE TEXT BEGIN\n([\s\S]*)\nSOURCE TEXT END/

function extractSource(prompt: string): string {
  const match = SOURCE.exec(prompt)
  return match?.[1] ?? ''
}

function answered(text: string) {
  return { isAnswered: true as const, text, usage: USAGE }
}

function installModel(
  on: On,
  respond: (source: string, system: string) => string,
): () => number {
  let calls = 0
  on('model.complete', ($, e) => {
    calls += 1
    return { value: answered(respond(extractSource(e.prompt), e.system ?? '')) }
  })
  return () => calls
}

function translated(source: string): string {
  return JSON.stringify({ translation: source })
}

function registerRenderBottoms(on: On): void {
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.text) as RenderElement
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, 'tool row') as RenderElement
  })
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, null, e.props.text) as RenderElement
  })
}

function assistantInput(text: string): RenderInput<'AssistantMessage'> {
  return {
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'm1',
    props: { text, isFirstOfReply: true },
  }
}

function userMessageInput(
  text: string,
  origin: PromptOrigin,
): RenderInput<'UserMessage'> {
  return {
    surface: 'terminal',
    component: 'UserMessage',
    requestId: 'u1',
    props: { text, origin, isExpanded: false },
  }
}

function toolUseInput(): RenderInput<'ToolUse'> {
  return {
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 't1',
    props: {
      tool_use_id: 't1',
      tool: 'Bash',
      input: { command: 'ls' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  }
}

function drawnText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(drawnText).join('')
  if (node !== null && typeof node === 'object') {
    return drawnText((node as { children?: unknown }).children)
  }
  return ''
}

test(
  '中文提示原样进入并附带英文译文上下文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    let reached = ''
    let context: readonly string[] | undefined
    const calls = installModel(on, () => translated('Hello from the test'))
    on('prompt.submit', ($, e) => {
      reached = e.text
      context = e.context
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(1)
    expect(reached).toBe('请帮我看看这个文件')
    expect(context?.join('\n')).toContain('Hello from the test')
  },
)

test(
  '输入语言不是英语时 context 标签跟随模型语言',
  { options: { translateInput: true, inputLanguage: 'ja' } },
  async ($, on) => {
    let context: readonly string[] | undefined
    const calls = installModel(on, () => translated('これはテストです'))
    on('prompt.submit', ($, e) => {
      context = e.context
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(1)
    expect(context?.join('\n')).toContain('Japanese translation')
    expect(context?.join('\n')).not.toContain('English translation')
  },
)

test(
  '用户行显示原始中文提示',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    let reached = ''
    installModel(on, () => translated('Hello from the test'))
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })
    expect(reached).toBe('请帮我看看这个文件')

    const composer = await $.ui.render(
      userMessageInput('请帮我看看这个文件', { kind: 'composer' }),
    )
    expect(drawnText(composer)).toBe('请帮我看看这个文件')

    const notification = await $.ui.render(
      userMessageInput('请帮我看看这个文件', { kind: 'task-notification' }),
    )
    expect(drawnText(notification)).toBe('请帮我看看这个文件')
  },
)

test(
  '瞬时失败不写入缓存并会重试',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    let calls = 0
    on('model.complete', () => {
      calls += 1
      return {
        value: {
          isAnswered: false as const,
          reason: 'api-error' as const,
          status: 529,
          error: 'overloaded' as const,
          usage: USAGE,
        },
      }
    })

    const source = 'This is the assistant reply.'
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls).toBe(1)

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls).toBe(2)
  },
)

test(
  '已经是模型语言的提示原样通过',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    let reached = ''
    const calls = installModel(on, () => 'should not be used')
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: 'Please look at this file',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(0)
    expect(reached).toBe('Please look at this file')
  },
)

test(
  '关闭提示翻译后不调用模型',
  { options: { translateInput: false } },
  async ($, on) => {
    let reached = ''
    const calls = installModel(on, () => 'should not be used')
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(0)
    expect(reached).toBe('请帮我看看这个文件')
  },
)

test(
  '任务通知不翻译也不调用模型',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    let reached = ''
    const calls = installModel(on, () => 'should not be used')
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'task-notification' },
    })

    expect(calls()).toBe(0)
    expect(reached).toBe('请帮我看看这个文件')
  },
)

test(
  '表格消息先画占位符，译文到达后显示译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(
      on,
      () => translated('| 区域 | 说明 |\n|---|---|\n| 客户端 | 这是中文说明 |'),
    )
    const source =
      '| Area | Notes |\n|---|---|\n| client | This is a long table cell with enough prose to translate. |'

    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toContain('翻译中')
    expect(calls()).toBe(0)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toContain('区域')
    expect(drawnText(second)).not.toBe(source)
  },
)

test(
  '表格消息翻译未完成时重绘仍显示占位符',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(
      on,
      () => translated('| 区域 | 说明 |\n|---|---|\n| 客户端 | 这是中文说明 |'),
    )
    const source =
      '| Area | Notes |\n|---|---|\n| client | This is a long table cell with enough prose to translate. |'

    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toContain('翻译中')

    // 模型调用还没完成，引擎重绘同一条消息：不能闪回英文表。
    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toContain('翻译中')
    expect(drawnText(second)).not.toContain('Area')
    expect(calls()).toBe(0)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)

    const translatedView = await $.ui.render(assistantInput(source))
    expect(drawnText(translatedView)).toContain('区域')
    expect(drawnText(translatedView)).not.toContain('翻译中')
  },
)

test(
  '首次绘制显示原文并由定时器启动翻译',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput('This is the assistant reply.'))
    expect(drawnText(first)).toBe('This is the assistant reply.')
    expect(calls()).toBe(0)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '选择对话框的入参翻成中文，答案还原成英文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    let asked: Array<Record<string, unknown>> = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      const first = asked[0]!
      const key = String(first.question)
      const options = first.options as Array<Record<string, unknown>>
      return {
        result: { questions: e.questions, answers: { [key]: options[0]!.label } },
      }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
    )

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({
      tool: 'AskUserQuestion',
      questions,
    })

    expect(calls()).toBe(1)
    expect(asked[0]?.question).toBe('用哪个库？')
    const options = asked[0]?.options as Array<Record<string, unknown>>
    expect(options[0]?.label).toBe('甲')
    expect(options[1]?.label).toBe('乙')
    expect(options[1]?.description).toBe('第二个选项。')

    const result = (response as { result: Record<string, unknown> }).result
    expect(result.questions).toEqual(questions)
    expect(result.answers).toEqual({ 'Which library?': 'Alpha' })

    await clock.advance(1)
    await clock.settle()

    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(1)
  },
)

test(
  '选择对话框的长问题译文语言不对时画原文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    let asked: Array<Record<string, unknown>> = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      const first = asked[0]!
      const key = String(first.question)
      const options = first.options as Array<Record<string, unknown>>
      return {
        result: { questions: e.questions, answers: { [key]: options[0]!.label } },
      }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["Which API?","API","REST","用 REST 完成集成。","GraphQL","用 GraphQL 完成集成。"]}',
    )

    const questions = [
      {
        question: 'Which API should the client use for this integration?',
        header: 'API',
        multiSelect: false,
        options: [
          { label: 'REST', description: 'Use the REST API for the integration.' },
          {
            label: 'GraphQL',
            description: 'Use the GraphQL API for the integration.',
          },
        ],
      },
    ]

    await $.tool.call({ tool: 'AskUserQuestion', questions })

    expect(calls()).toBe(1)
    expect(asked).toEqual(questions)

    await clock.advance(1)
    await clock.settle()

    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(1)
    expect(asked).toEqual(questions)
  },
)

test(
  '选择对话框的长问题正常翻译时短 header 和标签不误判',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    let asked: Array<Record<string, unknown>> = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      const first = asked[0]!
      const key = String(first.question)
      const options = first.options as Array<Record<string, unknown>>
      return {
        result: { questions: e.questions, answers: { [key]: options[0]!.label } },
      }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["服务集成应该使用哪个 API？","API","REST","用 REST API 完成集成。","GraphQL","用 GraphQL API 完成集成。"]}',
    )

    const questions = [
      {
        question: 'Which API should the service use for this integration?',
        header: 'API',
        multiSelect: false,
        options: [
          { label: 'REST', description: 'Use the REST API for the integration.' },
          {
            label: 'GraphQL',
            description: 'Use the GraphQL API for the integration.',
          },
        ],
      },
    ]

    await $.tool.call({ tool: 'AskUserQuestion', questions })

    expect(calls()).toBe(1)
    expect(asked[0]?.question).toBe('服务集成应该使用哪个 API？')
    expect(asked[0]?.header).toBe('API')
    const options = asked[0]?.options as Array<Record<string, unknown>>
    expect(options[0]?.label).toBe('REST')
    expect(options[1]?.label).toBe('GraphQL')

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '选择对话框里手输的中文答案翻成英文再回传模型',
  { options: { translateOutput: true, outputLanguage: 'zh', inputLanguage: 'en' } },
  async ($, on) => {
    const clock = mock.clock(on)

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      return {
        result: {
          questions: e.questions,
          answers: {
            '用哪个库？': '甲, 我在 Windows 上开发',
          },
          response: '能不能只用标准库？',
        },
      }
    })

    const prompts: string[] = []
    on('model.complete', ($, e) => {
      prompts.push(e.prompt)
      if ((e.system ?? '').includes('answers a person typed')) {
        const texts = JSON.parse(e.prompt) as string[]
        return {
          value: answered(
            JSON.stringify({
              translations: texts.map(text =>
                text === '我在 Windows 上开发'
                  ? 'I develop on Windows'
                  : 'Can it use only the standard library?',
              ),
            }),
          ),
        }
      }
      return {
        value: answered(
          '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
        ),
      }
    })

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({ tool: 'AskUserQuestion', questions })
    const result = (response as { result: Record<string, unknown> }).result

    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain('我在 Windows 上开发')
    expect(result.answers).toEqual({
      'Which library?': 'Alpha, I develop on Windows',
    })
    expect(result.response).toBe(
      'Can it use only the standard library?',
    )

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '长手输答案被模型截断时不采用短译文',
  { options: { translateOutput: true, outputLanguage: 'zh', inputLanguage: 'en' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const longAnswer =
      '我希望保留现有的接口兼容性，并且在不改变公开行为的前提下重构内部实现。'.repeat(30)

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      return {
        result: {
          questions: e.questions,
          answers: { '用哪个库？': `甲, ${longAnswer}` },
        },
      }
    })

    const prompts: string[] = []
    on('model.complete', ($, e) => {
      prompts.push(e.prompt)
      if ((e.system ?? '').includes('answers a person typed')) {
        return { value: answered('{"translations":["Short."]}') }
      }
      return {
        value: answered(
          '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
        ),
      }
    })

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({ tool: 'AskUserQuestion', questions })
    const result = (response as { result: Record<string, unknown> }).result

    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain(longAnswer)
    expect(result.answers).toEqual({
      'Which library?': `Alpha, ${longAnswer}`,
    })
    expect(JSON.stringify(result)).not.toContain('Short.')

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '手输答案翻译失败时保留原文',
  { options: { translateOutput: true, outputLanguage: 'zh', inputLanguage: 'en' } },
  async ($, on) => {
    const clock = mock.clock(on)

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      return {
        result: {
          questions: e.questions,
          answers: { '用哪个库？': '甲' },
          response: '随便写点什么',
        },
      }
    })

    on('model.complete', ($, e) => {
      if ((e.system ?? '').includes('answers a person typed')) {
        return { value: answered('not json') }
      }
      return {
        value: answered(
          '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
        ),
      }
    })

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({ tool: 'AskUserQuestion', questions })
    const result = (response as { result: Record<string, unknown> }).result

    expect(result.answers).toEqual({ 'Which library?': 'Alpha' })
    expect(result.response).toBe('随便写点什么')

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '关闭输入翻译时对话框答案只还原标签，不翻译手输文本',
  {
    options: {
      translateInput: false,
      translateOutput: true,
      outputLanguage: 'zh',
    },
  },
  async ($, on) => {
    const clock = mock.clock(on)

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      return {
        result: {
          questions: e.questions,
          answers: { '用哪个库？': '甲, 我在 Windows 上开发' },
          response: '能不能只用标准库？',
        },
      }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
    )

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({ tool: 'AskUserQuestion', questions })
    const result = (response as { result: Record<string, unknown> }).result

    expect(calls()).toBe(1)
    expect(result.answers).toEqual({
      'Which library?': 'Alpha, 我在 Windows 上开发',
    })
    expect(result.response).toBe('能不能只用标准库？')

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '关闭输出翻译但保留输入翻译时，手输答案仍翻成模型语言',
  {
    options: {
      translateInput: true,
      translateOutput: false,
      inputLanguage: 'en',
      outputLanguage: 'zh',
    },
  },
  async ($, on) => {
    let asked: Array<Record<string, unknown>> = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      return {
        result: {
          questions: e.questions,
          answers: { 'Which library?': 'Alpha, 我在 Windows 上开发' },
          response: '能不能只用标准库？',
        },
      }
    })

    const prompts: string[] = []
    on('model.complete', ($, e) => {
      prompts.push(e.prompt)
      const texts = JSON.parse(e.prompt) as string[]
      return {
        value: answered(
          JSON.stringify({
            translations: texts.map(text =>
              text === '我在 Windows 上开发'
                ? 'I develop on Windows'
                : 'Can it use only the standard library?',
            ),
          }),
        ),
      }
    })

    const questions = [
      {
        question: 'Which library?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    const response = await $.tool.call({ tool: 'AskUserQuestion', questions })
    const result = (response as { result: Record<string, unknown> }).result

    expect(prompts.length).toBe(1)
    expect(JSON.parse(prompts[0]!)).toEqual([
      '我在 Windows 上开发',
      '能不能只用标准库？',
    ])
    expect(asked[0]?.question).toBe('Which library?')
    expect(result.questions).toEqual(questions)
    expect(result.answers).toEqual({
      'Which library?': 'Alpha, I develop on Windows',
    })
    expect(result.response).toBe('Can it use only the standard library?')
  },
)

test(
  'goal 设置后给模型的目标提示行里，条件换成译文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('Fix the login problem'))
    const ack =
      'A session-scoped Stop hook is now active with condition: "修好登录问题". Briefly acknowledge the goal.'
    const session = mock.session(on)

    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: true,
        content: [{ type: 'text', text: ack }],
      },
      door: 'note',
      origin: { kind: 'engine' },
      uuid: 'n1',
    })

    const stored = session.appended().at(-1)
    expect(calls()).toBe(1)
    expect(stored?.message.content).toEqual([
      {
        type: 'text',
        text: ack.replace('修好登录问题', 'Fix the login problem'),
      },
    ])
  },
)

test(
  '其他 note 行不翻译也不调用模型',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => 'should not be used')
    const session = mock.session(on)

    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: true,
        content: [{ type: 'text', text: '随便一条说明' }],
      },
      door: 'note',
      origin: { kind: 'engine' },
      uuid: 'n2',
    })

    expect(calls()).toBe(0)
    expect(session.appended().at(-1)?.message.content).toEqual([
      { type: 'text', text: '随便一条说明' },
    ])
  },
)

test(
  '条件已是模型语言时原样通过',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => 'should not be used')
    const ack =
      'A session-scoped Stop hook is now active with condition: "Fix the login problem". Go.'
    const session = mock.session(on)

    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: true,
        content: [{ type: 'text', text: ack }],
      },
      door: 'note',
      origin: { kind: 'engine' },
      uuid: 'n3',
    })

    expect(calls()).toBe(0)
    expect(session.appended().at(-1)?.message.content).toEqual([
      { type: 'text', text: ack },
    ])
  },
)

test(
  'goal 提示行拆成多个 text block 时原样通过',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('Fix the login problem'))
    const ack =
      'A session-scoped Stop hook is now active with condition: "修好登录问题". Briefly acknowledge the goal.'
    const session = mock.session(on)

    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: true,
        content: [
          { type: 'text', text: ack },
          { type: 'text', text: 'extra' },
        ],
      },
      door: 'note',
      origin: { kind: 'engine' },
      uuid: 'n4',
    })

    expect(calls()).toBe(0)
    expect(session.appended().at(-1)?.message.content).toEqual([
      { type: 'text', text: ack },
      { type: 'text', text: 'extra' },
    ])
  },
)

test(
  '其他命令的输出行不改写',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    on('ui.render', { component: 'CommandOutput' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, e.props.text) as RenderElement
    })

    const tree = await $.ui.render({
      surface: 'terminal',
      component: 'CommandOutput',
      requestId: 'c2',
      props: {
        command: 'translator',
        args: 'status',
        text: 'Goal set: 修好登录问题',
        isErrored: false,
      },
    })

    expect(drawnText(tree)).toBe('Goal set: 修好登录问题')
  },
)

test(
  '翻译写入缓存后重绘显示译文且不改会话记录',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const session = mock.session(on)
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const source = 'This is the assistant reply.'
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe('这是助手的回复。')
    expect(calls()).toBe(1)
    expect(session.appended()).toEqual([])
  },
)

test(
  '新会话从 store 恢复翻译缓存，旧回复不再调用模型',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const source = 'This is the assistant reply.'
    const signature = translationSignature({
      inputLanguage: 'en',
      outputLanguage: 'zh',
      model: 'haiku',
      translationRules: '',
      promptVersion: PROMPT_TAG,
    })
    const key = cacheKey(signature, 'zh', 'output', source)

    mock.store(on, {
      cache: { [key]: { status: 'translated', text: '这是助手的回复。' } },
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'should not be used')

    const tree = await $.ui.render(assistantInput(source))

    expect(drawnText(tree)).toBe('这是助手的回复。')
    expect(calls()).toBe(0)
  },
)

test(
  '持久化缓存格式不合法时忽略并重新翻译',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on, { cache: { broken: { status: 'nope' } } })
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput('This is the assistant reply.'))
    expect(drawnText(first)).toBe('This is the assistant reply.')

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '占位符缺失时保留原文并缓存失败',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(on, source => {
      const placeholders = source.match(/@@JXZ_TRANSLATION_\d+@@/g) ?? []
      return translated(`在 ${placeholders[0] ?? ''} 中使用它。`)
    })

    const source = 'Use `useState` in C:\\Projects\\app\\main.ts now.'
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '响应不是严格 JSON 时保留原文并缓存失败',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'not json')

    const source = 'This reply is not valid JSON.'
    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '代码占比较高的长回复不会被误判为截断',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const prose = 'This reply explains the change in detail. '.repeat(10)
    const source = '```ts\n' + 'const value = 1\n'.repeat(40) + '```\n' + prose
    const calls = installModel(on, protectedSource => {
      const placeholder =
        protectedSource.match(/@@JXZ_TRANSLATION_\d+@@/)?.[0] ?? ''
      return translated(
        `${placeholder}\n${'这段说明解释了改动细节。'.repeat(15)}`,
      )
    })

    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).not.toBe(source)
    expect(calls()).toBe(1)
  },
)

test(
  '工具调用行不受翻译影响',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('不应被调用'))

    const tree = await $.ui.render(toolUseInput())

    expect(drawnText(tree)).toBe('tool row')
    expect(calls()).toBe(0)
  },
)

test(
  'translator output 在运行时切换输出语言且立即生效',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const reply = await $.command.run({
      command: 'translator',
      args: 'output en',
    })
    expect(reply.text).toContain('outputLanguage=en')

    const source = 'This is the assistant reply.'
    const tree = await $.ui.render(assistantInput(source))
    expect(drawnText(tree)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(0)
  },
)

test(
  '排队翻译期间切换输出语言，译文按渲染时的语言写入缓存',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    registerRenderBottoms(on)
    const calls = installModel(on, (_source, system) =>
      system.includes('Japanese')
        ? translated('これはテストです')
        : translated('这是中文译文。'),
    )
    const source = 'This is the assistant reply.'

    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)
    expect(calls()).toBe(0)

    // 译文还在排队时切到日文；排队任务应仍按渲染时的中文设置翻译。
    await $.command.run({ command: 'translator', args: 'output ja' })

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)

    // 切回中文后，旧 key 里必须是中文译文，而不是排队期间新设置的日文译文。
    await $.command.run({ command: 'translator', args: 'output zh' })
    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe('这是中文译文。')
  },
)

test(
  'btw 侧问要求按输出语言回答',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    let args = ''
    on('command.run', { command: 'btw' }, ($, e) => {
      args = e.args
      return { text: '' }
    })

    await $.command.run({ command: 'btw', args: '解释一下这个函数' })

    expect(args).toContain('解释一下这个函数')
    expect(args).toContain('Answer in Simplified Chinese')
  },
)

test(
  'translator status 显示当前设置',
  { options: { model: 'sonnet', inputLanguage: 'en', outputLanguage: 'zh' } },
  async ($, on) => {
    mock.store(on)

    const reply = await $.command.run({
      command: 'translator',
      args: 'status',
    })

    expect(reply.text).toContain('model=sonnet')
    expect(reply.text).toContain('inputLanguage=en')
    expect(reply.text).toContain('outputLanguage=zh')
  },
)

test(
  'translator reset 回到注册时的插件选项',
  { options: { outputLanguage: 'ja', model: 'sonnet' } },
  async ($, on) => {
    mock.store(on)

    const changed = await $.command.run({
      command: 'translator',
      args: 'output en',
    })
    expect(changed.text).toContain('outputLanguage=en')

    const reset = await $.command.run({
      command: 'translator',
      args: 'reset',
    })
    expect(reset.text).toContain('outputLanguage=ja')
    expect(reset.text).toContain('model=sonnet')

    const status = await $.command.run({
      command: 'translator',
      args: 'status',
    })
    expect(status.text).toContain('outputLanguage=ja')
    expect(status.text).toContain('model=sonnet')
  },
)

test(
  '持久化缓存里的失败条目不再让原文永久停在原文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const source = 'This is the assistant reply.'
    const signature = translationSignature({
      inputLanguage: 'en',
      outputLanguage: 'zh',
      model: 'haiku',
      translationRules: '',
      promptVersion: PROMPT_TAG,
    })
    const key = cacheKey(signature, 'zh', 'output', source)

    mock.store(on, {
      cache: { [key]: { status: 'failed', reason: 'malformed-response: x' } },
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe('这是助手的回复。')
    expect(calls()).toBe(1)
  },
)

test(
  '新会话从 store 恢复保存的设置',
  { options: { model: 'haiku', inputLanguage: 'en', outputLanguage: 'zh' } },
  async ($, on) => {
    mock.store(on, {
      settings: {
        translateInput: false,
        inputLanguage: 'ja',
        translateOutput: true,
        outputLanguage: 'en',
        model: 'sonnet',
        translationRules: '- 保留术语',
      },
    })
    on('session.start', ($inner, e) => e)
    await $.session.start({ cwd: '.' })

    const reply = await $.command.run({
      command: 'translator',
      args: 'status',
    })

    expect(reply.text).toContain('translateInput=false')
    expect(reply.text).toContain('inputLanguage=ja')
    expect(reply.text).toContain('translateOutput=true')
    expect(reply.text).toContain('outputLanguage=en')
    expect(reply.text).toContain('model=sonnet')
    expect(reply.text).toContain('translationRules=- 保留术语')
  },
)

test(
  '存储设置里的非法值回退到注册选项',
  { options: { model: 'haiku', inputLanguage: 'en', outputLanguage: 'zh' } },
  async ($, on) => {
    mock.store(on, {
      settings: {
        outputLanguage: 'xx',
        model: 123,
        translationRules: null,
        translateInput: 'yes',
      },
    })
    on('session.start', ($inner, e) => e)
    await $.session.start({ cwd: '.' })

    const reply = await $.command.run({
      command: 'translator',
      args: 'status',
    })

    expect(reply.text).toContain('translateInput=true')
    expect(reply.text).toContain('inputLanguage=en')
    expect(reply.text).toContain('outputLanguage=zh')
    expect(reply.text).toContain('model=haiku')
    expect(reply.text).toContain('translationRules=(empty)')
    expect(reply.text).not.toContain('outputLanguage=xx')
    expect(reply.text).not.toContain('model=123')
  },
)

test(
  '存储设置只提供部分字段时其余字段沿用注册选项',
  { options: { outputLanguage: 'fr' } },
  async ($, on) => {
    mock.store(on, { settings: { inputLanguage: 'ja' } })
    on('session.start', ($inner, e) => e)
    await $.session.start({ cwd: '.' })

    const reply = await $.command.run({
      command: 'translator',
      args: 'status',
    })

    expect(reply.text).toContain('inputLanguage=ja')
    expect(reply.text).toContain('outputLanguage=fr')
    expect(reply.text).not.toContain('outputLanguage=zh')
  },
)

test('每个设置键都能持久化、恢复并显示在 status 里', {}, async () => {
  const defaults: Options = {
    translateInput: true,
    inputLanguage: 'en',
    translateOutput: true,
    outputLanguage: 'zh',
    model: 'haiku',
    translationRules: '',
  }
  const config: Options = {
    translateInput: false,
    inputLanguage: 'ja',
    translateOutput: false,
    outputLanguage: 'en',
    model: 'sonnet',
    translationRules: '- 保留术语',
  }

  const payload = settingsPayload(config)
  const lines = describeSettings(config)

  expect(Object.keys(payload)).toEqual([...SETTING_KEYS])
  expect(lines).toEqual([
    'translateInput=false',
    'inputLanguage=ja',
    'translateOutput=false',
    'outputLanguage=en',
    'model=sonnet',
    'translationRules=- 保留术语',
  ])

  for (const key of SETTING_KEYS) {
    // 每个键都取非默认值，否则回退到默认值也能让往返测试通过。
    expect(config[key]).not.toEqual(defaults[key])
    expect(payload[key]).toEqual(config[key])
    expect(lines.some(line => line.startsWith(`${key}=`))).toBe(true)
  }

  expect(applyStoredSettings(defaults, payload)).toEqual(config)
})

test('时钟缺失或抛错时清掉 pending，下一次还能重试', {}, async () => {
  const key = 'schedule-failure-retry'
  let started = 0
  const start = () => {
    started += 1
  }
  const missing:
    | { after(delay: number, callback: () => void): unknown }
    | undefined = undefined

  expect(
    scheduleTranslation(callback => missing!.after(1, callback), key, start),
  ).toBe('failed')
  expect(
    scheduleTranslation(
      () => {
        throw new Error('clock-unavailable')
      },
      key,
      start,
    ),
  ).toBe('failed')

  const queued: Array<() => void> = []
  expect(
    scheduleTranslation(
      callback => {
        queued.push(callback)
      },
      key,
      start,
    ),
  ).toBe('scheduled')
  expect(started).toBe(0)
  queued[0]!()
  expect(started).toBe(1)
})

test('同一 key 已调度时返回 busy，不重复启动', {}, async () => {
  const key = 'schedule-busy-dedup'
  let started = 0
  const start = () => {
    started += 1
  }
  const clock = (callback: () => void) => {
    callback()
  }

  expect(scheduleTranslation(clock, key, start)).toBe('scheduled')
  expect(started).toBe(1)
  expect(scheduleTranslation(clock, key, start)).toBe('busy')
  expect(started).toBe(1)
})
