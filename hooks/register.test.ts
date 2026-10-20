import { expect, mock, test } from 'claude-code/testing'
import type {
  On,
  PromptOrigin,
  RenderElement,
  RenderInput,
} from 'claude-code'
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
  'goal 命令输出行只把英文前缀换成中文，条件保持原文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    on('ui.render', { component: 'CommandOutput' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, e.props.text) as RenderElement
    })

    const tree = await $.ui.render({
      surface: 'terminal',
      component: 'CommandOutput',
      requestId: 'c1',
      props: {
        command: 'goal',
        args: '修好登录问题',
        text: 'Goal set: 修好登录问题',
        isErrored: false,
      },
    })

    expect(drawnText(tree)).toBe('目标已设置：修好登录问题')
  },
)

test(
  '用户自己打的 Goal set 开头的提示不被改写',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => 'should not be used')

    const tree = await $.ui.render(
      userMessageInput('Goal set: 修好登录问题', { kind: 'composer' }),
    )

    expect(drawnText(tree)).toBe('Goal set: 修好登录问题')
  },
)

test(
  '命令输出行带 stdout 包裹时改前缀',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => 'should not be used')

    const tree = await $.ui.render(
      userMessageInput(
        '<local-command-stdout>Goal set: 修好登录</local-command-stdout>',
        { kind: 'composer' },
      ),
    )

    expect(drawnText(tree)).toBe(
      '<local-command-stdout>目标已设置：修好登录</local-command-stdout>',
    )
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
    })
    const key = cacheKey(signature, 'zh', source)

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
