import { expect, mock, test } from 'claude-code/testing'
import type {
  CommandRunInput,
  On,
  PromptOrigin,
  RenderElement,
  RenderInput,
  SessionStartInput,
} from 'claude-code'
import { PROMPT_TAG } from './prompt'
import {
  applyStoredSettings,
  describeSettings,
  SETTING_KEYS,
  settingsPayload,
} from './commands'
import type { Options } from './commands'
import { scheduleTranslation } from './register'
import {
  createStorageState,
  excessCacheKeys,
  rememberOriginal,
  rememberPersistedEntry,
  retainPersistedKeys,
  storedCacheEntrySizeKey,
} from './storage'
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

// 测试里的 `$` 是引擎调用侧，收完整入参；插件侧的同名 API 才允许省略
// 引擎自己填的 origin / presentation / surface / isInteractive。
function commandRunInput(command: string, args: string): CommandRunInput {
  return {
    command,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  }
}

function sessionStartInput(cwd: string): SessionStartInput {
  return { cwd, surface: 'terminal', isInteractive: true }
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

// 缓存测试统一用这份签名，store key 只随原文变化。
function outputCacheKey(source: string): string {
  return cacheKey(
    translationSignature({
      inputLanguage: 'en',
      outputLanguage: 'zh',
      model: 'haiku',
      translationRules: '',
      promptVersion: PROMPT_TAG,
    }),
    'zh',
    'output',
    source,
  )
}

function cacheEntryStoreKey(source: string): string {
  return `cache-entry:${outputCacheKey(source)}`
}

function cacheSizeStoreKey(source: string, textLength: number): string {
  return storedCacheEntrySizeKey(outputCacheKey(source), textLength)
}

const CHINESE_UNIT = '请帮我看看这个文件'
const ENGLISH_UNIT = 'Please review the login flow carefully. '

// 拼出指定长度的单行提示，用来卡 MAX_INPUT_LENGTH 的边界。
function repeated(unit: string, length: number): string {
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
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
  messageId = 'u1',
): RenderInput<'UserMessage'> {
  return {
    surface: 'terminal',
    component: 'UserMessage',
    requestId: messageId,
    props: { text, origin, isExpanded: false },
  }
}

function appendedUserMessage(text: string, messageId: string) {
  return {
    message: {
      type: 'user',
      role: 'user',
      isMeta: false,
      content: [{ type: 'text', text }],
    },
    door: 'user',
    origin: { kind: 'composer' },
    uuid: messageId,
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
  '中文提示被替换成译文提交，查看时按消息 ID 显示原文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
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
    await $.session.append(
      appendedUserMessage('Hello from the test', 'm-input-1') as never,
    )

    expect(calls()).toBe(1)
    expect(reached).toBe('Hello from the test')
    expect(context).toBeUndefined()

    const drawn = await $.ui.render(
      userMessageInput(
        'Hello from the test',
        { kind: 'composer' },
        'm-input-1',
      ),
    )
    expect(drawnText(drawn)).toBe('请帮我看看这个文件')
  },
)

test(
  '输入语言是日语时提交的是日语译文',
  { options: { translateInput: true, inputLanguage: 'ja' } },
  async ($, on) => {
    let reached = ''
    let context: readonly string[] | undefined
    const calls = installModel(on, () => translated('これはテストです'))
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
    expect(reached).toBe('これはテストです')
    expect(context).toBeUndefined()
  },
)

test(
  '用户行按消息 ID 显示原始中文提示',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => translated('Hello from the test'))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append(
      appendedUserMessage('Hello from the test', 'm-user-1') as never,
    )

    const translatedRow = await $.ui.render(
      userMessageInput(
        'Hello from the test',
        { kind: 'composer' },
        'm-user-1',
      ),
    )
    expect(drawnText(translatedRow)).toBe('请帮我看看这个文件')

    const notification = await $.ui.render(
      userMessageInput('请帮我看看这个文件', { kind: 'task-notification' }),
    )
    expect(drawnText(notification)).toBe('请帮我看看这个文件')
  },
)

test(
  '带非文本 block 的用户消息仍按消息 ID 显示原始中文提示',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => translated('Hello from the test'))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: false,
        content: [
          { type: 'image', source: { type: 'base64', data: 'abc' } },
          { type: 'text', text: 'Hello from the test' },
        ],
      },
      door: 'user',
      origin: { kind: 'composer' },
      uuid: 'm-user-image-1',
    } as never)

    const translatedRow = await $.ui.render(
      userMessageInput(
        'Hello from the test',
        { kind: 'composer' },
        'm-user-image-1',
      ),
    )
    expect(drawnText(translatedRow)).toBe('请帮我看看这个文件')
  },
)

test(
  '两条不同原文译成同一文本时各显示自己的原文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => translated('OK'))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    await $.prompt.submit({
      text: '好的',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append(appendedUserMessage('OK', 'm-ok-1') as never)

    await $.prompt.submit({
      text: '可以',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append(appendedUserMessage('OK', 'm-ok-2') as never)

    const first = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-ok-1'),
    )
    const second = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-ok-2'),
    )
    expect(drawnText(first)).toBe('好的')
    expect(drawnText(second)).toBe('可以')
  },
)

test(
  '新会话从 store 恢复原文映射',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    mock.store(on, { 'originals:m-old': '旧的原文' })
    on('session.start', ($inner, e) => e)
    await $.session.start(sessionStartInput('.'))

    const drawn = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-old'),
    )
    expect(drawnText(drawn)).toBe('旧的原文')
  },
)

test(
  '启动时不批量读取逐条原文，渲染时按需读取一次并缓存',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    const store: Record<string, unknown> = {
      'originals:m-lazy-1': '第一条原文',
      'originals:m-lazy-2': '第二条原文',
    }

    let perKeyReads = 0
    on('store.keys', () => ({ value: Object.keys(store) }))
    on('store.get', (_$inner, e) => {
      if (e.key.startsWith('originals:')) {
        perKeyReads += 1
      }
      return { value: store[e.key] }
    })

    on('session.start', ($inner, e) => e)
    await $.session.start(sessionStartInput('.'))
    expect(perKeyReads).toBe(0)

    const first = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-lazy-1'),
    )
    expect(drawnText(first)).toBe('第一条原文')
    expect(perKeyReads).toBe(1)

    const second = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-lazy-1'),
    )
    expect(drawnText(second)).toBe('第一条原文')
    expect(perKeyReads).toBe(1)
  },
)

test(
  '各自独立写原文，新会话重载后三条都还在',
  {
    options: { translateInput: true, inputLanguage: 'en' },
    plugins: [
      {
        name: 'originals-probe',
        // 直接看 store 里的键值，绕开会话里的内存映射，
        // 确保是逐条写入而不是只在当前会话里能显示。
        register(on) {
          on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
            const expected: Record<string, string> = {
              'originals:m-old': '旧的原文',
              'originals:m-new-1': '第一条新原文',
              'originals:m-new-2': '第二条新原文',
            }
            for (const [key, value] of Object.entries(expected)) {
              if ((await $.store.get(key)) !== value) {
                throw new Error(
                  `store 里 ${key} 的值不对：${JSON.stringify(await $.store.get(key))}`,
                )
              }
            }
            return next(e)
          })
        },
      },
    ],
  },
  async ($, on) => {
    registerRenderBottoms(on)
    mock.store(on, { 'originals:m-old': '旧的原文' })
    installModel(on, () => translated('OK'))
    on('prompt.submit', ($inner, e) => ({ text: e.text }))
    on('session.start', ($inner, e) => e)

    // 两个写入方各写自己那条消息：各自只落自己的 key，不整表回写。
    await $.prompt.submit({
      text: '第一条新原文',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append(appendedUserMessage('OK', 'm-new-1') as never)
    await $.prompt.submit({
      text: '第二条新原文',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.session.append(appendedUserMessage('OK', 'm-new-2') as never)

    // 新会话从 store 逐条装回。
    await $.session.start(sessionStartInput('.'))

    const seeded = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-old'),
    )
    const first = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-new-1'),
    )
    const second = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-new-2'),
    )
    expect(drawnText(seeded)).toBe('旧的原文')
    expect(drawnText(first)).toBe('第一条新原文')
    expect(drawnText(second)).toBe('第二条新原文')
  },
)

test(
  '新会话启动时按上限修剪 store 里最旧的原文',
  {
    options: { translateInput: true, inputLanguage: 'en' },
    plugins: [
      {
        name: 'prune-probe',
        // 渲染时读 store，确认删除真的落到了存储里，不只是没装进内存映射。
        register(on) {
          on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
            const keys = await $.store.keys()
            if (keys.includes('originals:m-0')) {
              throw new Error('store 里最旧的原文没有被修剪')
            }
            if (keys.length !== 2000) {
              throw new Error(`store 里还剩 ${keys.length} 条`)
            }
            return next(e)
          })
        },
      },
    ],
  },
  async ($, on) => {
    registerRenderBottoms(on)
    on('session.start', ($inner, e) => e)

    // 上限 2000：多存一条最旧的，启动后最旧的一条应被修剪掉。
    const entries: Record<string, string> = {}
    for (let index = 0; index < 2001; index += 1) {
      entries[`originals:m-${index}`] = `原文 ${index}`
    }
    mock.store(on, entries)

    await $.session.start(sessionStartInput('.'))

    const pruned = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-0'),
    )
    // 被修剪掉的最旧一条不再解析出原文，回退显示会话里的译文。
    expect(drawnText(pruned)).toBe('OK')

    const edge = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-1'),
    )
    const newest = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-2000'),
    )
    expect(drawnText(edge)).toBe('原文 1')
    expect(drawnText(newest)).toBe('原文 2000')
  },
)

test(
  '旧版整表 originals 里的原文升级后仍能显示',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    // 旧版本把原文存成一个整表键；升级后必须仍能读出，否则旧会话 --resume 丢原文。
    mock.store(on, { originals: { 'm-legacy': '旧格式原文' } })
    on('session.start', ($inner, e) => e)
    await $.session.start(sessionStartInput('.'))

    const drawn = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-legacy'),
    )
    expect(drawnText(drawn)).toBe('旧格式原文')
  },
)

test(
  '同一消息 ID 新格式逐条键优先于旧版整表',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    mock.store(on, {
      originals: { 'm-both': '旧格式原文' },
      'originals:m-both': '新格式原文',
    })
    on('session.start', ($inner, e) => e)
    await $.session.start(sessionStartInput('.'))

    const drawn = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-both'),
    )
    expect(drawnText(drawn)).toBe('新格式原文')
  },
)

test(
  '输入翻译瞬时失败会重试一次再替换',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    let calls = 0
    on('model.complete', () => {
      calls += 1
      if (calls === 1) {
        return {
          value: {
            isAnswered: false as const,
            reason: 'api-error' as const,
            status: 529,
            error: 'overloaded' as const,
            usage: USAGE,
          },
        }
      }
      return { value: answered(translated('Hello again')) }
    })

    let reached = ''
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '再看看',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls).toBe(2)
    expect(reached).toBe('Hello again')
  },
)

test(
  '连续提交时排队的原文都按顺序绑定',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => translated('OK'))
    on('prompt.submit', ($, e) => ({ text: e.text }))

    // 两条都还没落库就先提交下一条；清空队列会丢掉第一条的原文映射。
    await $.prompt.submit({
      text: '第一条',
      wait: false,
      origin: { kind: 'composer' },
    })
    await $.prompt.submit({
      text: '第二条',
      wait: false,
      origin: { kind: 'composer' },
    })

    await $.session.append(appendedUserMessage('OK', 'm-q1') as never)
    await $.session.append(appendedUserMessage('OK', 'm-q2') as never)

    const first = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-q1'),
    )
    const second = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-q2'),
    )
    expect(drawnText(first)).toBe('第一条')
    expect(drawnText(second)).toBe('第二条')
  },
)

test(
  '输入翻译失败时丢弃提交，模型收不到原文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    installModel(on, () => 'not json')
    let reached = ''
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    const answer = (await $.prompt.submit({
      text: '请修好登录',
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string; text?: string }

    expect(reached).toBe('')
    expect(answer.text).toBeUndefined()
    expect(answer.drop).toContain('翻译失败')
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
  '恰好 20000 字符的可翻译提示照常翻译',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const source = repeated(CHINESE_UNIT, 20_000)
    const target = repeated(ENGLISH_UNIT, 20_000)

    let reached = ''
    const calls = installModel(on, () => translated(target))
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    const answer = (await $.prompt.submit({
      text: source,
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string; text?: string }

    expect(calls()).toBe(1)
    expect(answer.drop).toBeUndefined()
    expect(answer.text).toBe(target)
    expect(reached).toBe(target)
  },
)

test(
  '超过 20000 字符的可翻译提示被丢弃，不把原文交给模型',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const source = repeated(CHINESE_UNIT, 20_001)

    let reached = ''
    const calls = installModel(
      on,
      () => translated(repeated(ENGLISH_UNIT, 20_001)),
    )
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    const answer = (await $.prompt.submit({
      text: source,
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string; text?: string }

    expect(calls()).toBe(0)
    expect(reached).toBe('')
    expect(answer.text).toBeUndefined()
    expect(answer.drop).toContain('过长')
  },
)

test(
  '超过 20000 字符但无需翻译的提示原样通过',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const source = repeated(ENGLISH_UNIT, 20_001)

    let reached = ''
    const calls = installModel(on, () => 'should not be used')
    on('prompt.submit', ($, e) => {
      reached = e.text
      return { text: e.text }
    })

    const answer = (await $.prompt.submit({
      text: source,
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string; text?: string }

    expect(calls()).toBe(0)
    expect(answer.drop).toBeUndefined()
    expect(reached).toBe(source)
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
  '选择对话框首次回复 JSON 损坏时纠正重试并显示译文',
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

    // 第一次回复是截断的 JSON，纠正重试才拿到完整译文。
    const prompts: string[] = []
    on('model.complete', ($, e) => {
      prompts.push(e.prompt)
      return {
        value: answered(
          prompts.length === 1
            ? '{"translations":["用哪个库？",'
            : '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
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

    await $.tool.call({ tool: 'AskUserQuestion', questions })

    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain('{"translations":[...]}')
    expect(asked[0]?.question).toBe('用哪个库？')
    const options = asked[0]?.options as Array<Record<string, unknown>>
    expect(options[0]?.label).toBe('甲')
    expect(options[1]?.label).toBe('乙')

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '选择对话框两次回复都损坏时不缓存失败，下次仍重试',
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

    // 首发和重试都损坏：对话框画原文，但失败不写入缓存。
    const calls = installModel(on, () => 'not json')

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

    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(2)
    expect(asked).toEqual(questions)

    await clock.advance(1)
    await clock.settle()

    // 缓存里没有这条失败：同一对话框重开时重新请求（首发 + 重试）。
    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(4)
    expect(asked).toEqual(questions)

    await clock.advance(1)
    await clock.settle()
  },
)

test(
  '选择对话框的内存失败条目会重查 store，其他会话成功后显示译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    // A 会话把长问题译成英文，得到非瞬时的 wrong-language 失败并写进内存；
    // B 会话随后用同一个 key 成功持久化，A 重开对话框应显示译文且不再请求模型。
    const clock = mock.clock(on)
    let asked: Array<Record<string, unknown>> = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($inner, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      const first = asked[0]!
      const key = String(first.question)
      const options = first.options as Array<Record<string, unknown>>
      return {
        result: { questions: e.questions, answers: { [key]: options[0]!.label } },
      }
    })

    const stored = new Map<string, unknown>()
    let storeKey: string | undefined
    let entryReads = 0
    on('store.get', ($inner, e) => {
      if (!e.key.startsWith('cache-entry:')) return { value: undefined }
      storeKey = e.key
      entryReads += 1
      return { value: stored.get(e.key) }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["Which library should the client use for this integration?","Library","Alpha","First option.","Beta","Second option."]}',
    )

    const questions = [
      {
        question: 'Which library should the client use for this integration?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Alpha', description: 'First option.' },
          { label: 'Beta', description: 'Second option.' },
        ],
      },
    ]

    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(1)
    expect(asked).toEqual(questions)
    await clock.advance(1)
    await clock.settle()
    expect(storeKey).toBeDefined()
    expect(entryReads).toBe(1)

    // B 写入之前重开：store 仍为空，重查后保留失败，不重新请求模型。
    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(entryReads).toBe(2)
    expect(calls()).toBe(1)
    expect(asked).toEqual(questions)
    await clock.advance(1)
    await clock.settle()

    // B 用 A 首次读取的同一个 key 成功翻译并持久化。
    stored.set(storeKey!, {
      status: 'translated',
      text: '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}',
    })

    // A 重开：选项显示译文，模型调用次数不变。
    await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(1)
    const shown = asked[0]!
    expect(shown.question).toBe('用哪个库？')
    const options = shown.options as Array<Record<string, unknown>>
    expect(options[0]?.label).toBe('甲')
    expect(options[1]?.label).toBe('乙')
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '选择对话框的长问题被模型截断成短句时画原文',
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

    // 语言对、条数也对，只有长度短得离谱，只能靠截断检查拦下。
    const calls = installModel(
      on,
      () =>
        '{"translations":["用哪个？","API","REST","用 REST 完成集成。","GraphQL","用 GraphQL 完成集成。"]}',
    )

    const longQuestion =
      'Which API should the client use for this integration when the existing service must keep working across every supported deployment, and which one keeps the migration path simple for the team? '.repeat(
        3,
      )

    const questions = [
      {
        question: longQuestion,
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

    expect(longQuestion.length).toBeGreaterThan(400)

    await $.tool.call({ tool: 'AskUserQuestion', questions })

    expect(calls()).toBe(1)
    expect(asked).toEqual(questions)
    expect(asked[0]?.question).toBe(longQuestion)

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
        multiSelect: true,
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
        multiSelect: true,
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
        multiSelect: true,
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
        multiSelect: true,
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

    mock.store(on, {
      [cacheEntryStoreKey(source)]: {
        status: 'translated',
        text: '这是助手的回复。',
      },
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'should not be used')

    const tree = await $.ui.render(assistantInput(source))

    expect(drawnText(tree)).toBe('这是助手的回复。')
    expect(calls()).toBe(0)
  },
)

test(
  '持久化条目格式不合法时忽略并重新翻译',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const source = 'This is the assistant reply.'
    mock.store(on, {
      [cacheEntryStoreKey(source)]: { status: 'nope' },
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)
  },
)

test(
  '持久化条目按 key 懒读一次，后续渲染不再访问 store',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    // 读 store 发生在每条助手消息的渲染路径上；命中或确认缺失都必须记住，
    // 否则同一条消息每次重绘都会再打一次跨会话的 store。
    const source = 'This is the assistant reply.'
    const storeKey = cacheEntryStoreKey(source)
    const stored = new Map<string, unknown>([
      [storeKey, { status: 'translated', text: '这是助手的回复。' }],
    ])
    let entryReads = 0
    on('store.get', ($inner, e) => {
      if (e.key === storeKey) entryReads += 1
      return { value: stored.get(e.key) }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput(source))
    const second = await $.ui.render(assistantInput(source))

    expect(drawnText(first)).toBe('这是助手的回复。')
    expect(drawnText(second)).toBe('这是助手的回复。')
    expect(entryReads).toBe(1)
  },
)

test(
  '持久化条目确认缺失后同 key 不再重复读 store',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const source = 'This reply is not cached anywhere.'
    const storeKey = cacheEntryStoreKey(source)
    let entryReads = 0
    on('store.get', ($inner, e) => {
      if (e.key === storeKey) entryReads += 1
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是新翻的译文。'))

    // 翻译定时器还没执行；两次渲染都必须记住“已确认缺失”，不再读 store。
    const first = await $.ui.render(assistantInput(source))
    const second = await $.ui.render(assistantInput(source))

    expect(drawnText(first)).toBe(source)
    expect(drawnText(second)).toBe(source)
    expect(entryReads).toBe(1)
    await clock.settle()
  },
)

test(
  '持久化条目读失败不记为缺失，下次渲染会再试',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    // 第一次读 store 被拒（临时故障）：不能当作永久缺失，
    // 否则本次会话再也不会跨会话复用这条译文。
    const clock = mock.clock(on)
    const source = 'This is the assistant reply.'
    let entryReads = 0
    on('store.get', ($inner, e) => {
      if (e.key !== cacheEntryStoreKey(source)) return { value: undefined }
      entryReads += 1
      if (entryReads === 1) return { deny: 'transient-failure' }
      return { value: { status: 'translated', text: '跨会话的旧译文。' } }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput(source))
    // 翻译定时器还没执行；这次渲染必须重新读 store 并显示读到的旧译文。
    const second = await $.ui.render(assistantInput(source))

    expect(drawnText(first)).toBe(source)
    expect(drawnText(second)).toBe('跨会话的旧译文。')
    expect(entryReads).toBe(2)
    await clock.settle()
  },
)

test(
  '逐条持久化不会覆盖其他会话写入的译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    const writes: string[] = []
    let legacyReads = 0
    let legacyWrites = 0
    on('store.get', ($inner, e) => {
      if (e.key === 'cache') legacyReads += 1
      return { value: stored.get(e.key) }
    })
    on('store.set', ($inner, e) => {
      if (e.key === 'cache') legacyWrites += 1
      else writes.push(e.key)
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是本会话的译文。'))

    const localSource = 'Reply translated in this session.'
    const externalSource = 'Reply translated in another session.'
    const laterSource = 'Another reply translated in this session.'
    const translatedText = '这是本会话的译文。'
    const localStoreKey = cacheEntryStoreKey(localSource)
    const externalStoreKey = cacheEntryStoreKey(externalSource)
    const laterStoreKey = cacheEntryStoreKey(laterSource)
    const localSizeKey = cacheSizeStoreKey(localSource, translatedText.length)
    const laterSizeKey = cacheSizeStoreKey(laterSource, translatedText.length)

    // 本会话写入 A。
    await $.ui.render(assistantInput(localSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()
    expect(stored.get(localStoreKey)).toEqual({
      status: 'translated',
      text: '这是本会话的译文。',
    })

    // 另一并发会话直接写入 B。
    stored.set(externalStoreKey, {
      status: 'translated',
      text: '另一会话的译文。',
    })

    // 本会话再翻译一条 C，触发第二次持久化。
    await $.ui.render(assistantInput(laterSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    // A、B、C 都在，且 B 没有被本会话的整表回写覆盖。
    expect(stored.get(localStoreKey)).toEqual({
      status: 'translated',
      text: '这是本会话的译文。',
    })
    expect(stored.get(externalStoreKey)).toEqual({
      status: 'translated',
      text: '另一会话的译文。',
    })
    expect(stored.get(laterStoreKey)).toEqual({
      status: 'translated',
      text: '这是本会话的译文。',
    })
    // 已写过的 A 不重写，本次只写新条目 C；每条正文后跟一个大小标记。
    expect(writes).toEqual([
      localStoreKey,
      localSizeKey,
      laterStoreKey,
      laterSizeKey,
    ])
    expect(stored.get(localSizeKey)).toBe(translatedText.length)
    expect(stored.get(laterSizeKey)).toBe(translatedText.length)
    // 旧版整表 'cache' 键不再读写。
    expect(legacyReads).toBe(0)
    expect(legacyWrites).toBe(0)
  },
)

test(
  '单条持久化写入失败不记为已写，下次持久化会重试',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    const writes: string[] = []
    let denyNextWrite = true
    on('store.get', ($inner, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($inner, e) => {
      writes.push(e.key)
      if (denyNextWrite) {
        denyNextWrite = false
        return { deny: 'disk-full' }
      }
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是本会话的译文。'))

    const firstSource = 'First reply of the batch.'
    const secondSource = 'Second reply of the batch.'
    const laterSource = 'Third reply after the failure.'
    const translatedText = '这是本会话的译文。'
    const firstKey = cacheEntryStoreKey(firstSource)
    const secondKey = cacheEntryStoreKey(secondSource)
    const laterKey = cacheEntryStoreKey(laterSource)
    const firstSizeKey = cacheSizeStoreKey(firstSource, translatedText.length)
    const secondSizeKey = cacheSizeStoreKey(secondSource, translatedText.length)
    const laterSizeKey = cacheSizeStoreKey(laterSource, translatedText.length)

    // 同一批翻译 A、B：第一次写 A 失败，B 仍要写入。
    await $.ui.render(assistantInput(firstSource))
    await $.ui.render(assistantInput(secondSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(stored.has(firstKey)).toBe(false)
    expect(stored.has(firstSizeKey)).toBe(false)
    expect(stored.get(secondKey)).toEqual({
      status: 'translated',
      text: translatedText,
    })
    expect(stored.get(secondSizeKey)).toBe(translatedText.length)

    // 下一条翻译触发持久化：失败的 A 正文和标记都重试，成功的 B 不重写。
    await $.ui.render(assistantInput(laterSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(stored.get(firstKey)).toEqual({
      status: 'translated',
      text: translatedText,
    })
    expect(stored.get(firstSizeKey)).toBe(translatedText.length)
    expect(stored.get(laterKey)).toEqual({
      status: 'translated',
      text: translatedText,
    })
    expect(stored.get(laterSizeKey)).toBe(translatedText.length)
    expect(writes).toEqual([
      firstKey,
      secondKey,
      secondSizeKey,
      firstKey,
      firstSizeKey,
      laterKey,
      laterSizeKey,
    ])
  },
)

test(
  '永久翻译失败不会触发缓存持久化写入',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    let persistCalls = 0
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => {
      persistCalls += 1
      return { value: undefined }
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'not valid json')

    await $.ui.render(assistantInput('Reply that fails to parse.'))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(calls()).toBe(2)
    expect(persistCalls).toBe(0)
  },
)

test(
  'session.start 再次触发时丢弃旧的按需读取结果，能看到其他会话新写入的译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const source = 'Reply persisted by another session.'
    const storeKey = cacheEntryStoreKey(source)
    const stored = new Map<string, unknown>([
      [storeKey, { status: 'translated', text: '旧译文。' }],
    ])
    on('store.get', ($inner, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($inner, e) => {
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    on('store.keys', () => ({ value: [...stored.keys()] }))
    on('session.start', ($inner, e) => e)
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'should not be used')

    await $.session.start(sessionStartInput('.'))
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe('旧译文。')

    // 本会话已确认过这个 key，其他会话随后改写了 store，渲染仍用已读结果。
    stored.set(storeKey, { status: 'translated', text: '新译文。' })
    const cached = await $.ui.render(assistantInput(source))
    expect(drawnText(cached)).toBe('旧译文。')

    // 再次 session.start 后按需读取结果作废，重新读 store 得到新译文。
    await $.session.start(sessionStartInput('.'))

    const refreshed = await $.ui.render(assistantInput(source))
    expect(drawnText(refreshed)).toBe('新译文。')
    expect(calls()).toBe(0)
  },
)

test(
  '新会话启动时按上限修剪 store 里最旧的译文条目',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    on('session.start', ($inner, e) => e)
    const entries = new Map<string, unknown>()
    for (let index = 0; index < 301; index += 1) {
      const text = `译文 ${index}`
      entries.set(`cache-entry:k-${index}`, {
        status: 'translated',
        text,
      })
      entries.set(
        storedCacheEntrySizeKey(`k-${index}`, text.length),
        text.length,
      )
    }
    let keysCalls = 0
    const deleted: string[] = []
    on('store.keys', () => {
      keysCalls += 1
      return { value: [...entries.keys()] }
    })
    on('store.get', ($inner, e) => ({ value: entries.get(e.key) }))
    on('store.delete', ($inner, e) => {
      deleted.push(e.key)
      entries.delete(e.key)
      return { value: undefined }
    })

    await $.session.start(sessionStartInput('.'))

    // 原文修剪和译文修剪复用同一次 keys() 调用。
    expect(keysCalls).toBe(1)
    // keys() 按插入顺序返回：301 条里只删最旧的一条，连同大小标记。
    expect(deleted).toEqual([
      'cache-entry:k-0',
      storedCacheEntrySizeKey('k-0', '译文 0'.length),
    ])
    expect(entries.get('cache-entry:k-300')).toEqual({
      status: 'translated',
      text: '译文 300',
    })
    expect(entries.has(storedCacheEntrySizeKey('k-1', '译文 1'.length))).toBe(
      true,
    )
  },
)

test(
  '新会话启动时按字符上限修剪最旧的译文和大小标记',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    on('session.start', ($inner, e) => e)
    const entries = new Map<string, unknown>()
    const text = 'x'.repeat(100_000)
    // 12 × 10 万字符超过 100 万上限，最旧的两条及其标记应被删除。
    for (let index = 0; index < 12; index += 1) {
      const entryKey = `k-${index}`
      entries.set(`cache-entry:${entryKey}`, {
        status: 'translated',
        text,
      })
      entries.set(storedCacheEntrySizeKey(entryKey, text.length), text.length)
    }
    // 同一正文的旧标记（并发重写）按最大长度计费，淘汰标记时一并清理。
    const staleMarker = storedCacheEntrySizeKey('k-11', 50_000)
    entries.set(staleMarker, 50_000)
    // 正文已不存在的孤儿标记也要清掉。
    const orphanMarker = storedCacheEntrySizeKey('gone', 1234)
    entries.set(orphanMarker, 1234)

    let keysCalls = 0
    let entryReads = 0
    const deleted: string[] = []
    on('store.keys', () => {
      keysCalls += 1
      return { value: [...entries.keys()] }
    })
    on('store.get', ($inner, e) => {
      if (e.key.startsWith('cache-entry:')) entryReads += 1
      return { value: entries.get(e.key) }
    })
    on('store.delete', ($inner, e) => {
      deleted.push(e.key)
      entries.delete(e.key)
      return { value: undefined }
    })

    await $.session.start(sessionStartInput('.'))

    expect(keysCalls).toBe(1)
    // 修剪只靠 key 名里的字符数，不读取任何译文正文。
    expect(entryReads).toBe(0)
    expect(deleted).toEqual([
      'cache-entry:k-0',
      storedCacheEntrySizeKey('k-0', text.length),
      'cache-entry:k-1',
      storedCacheEntrySizeKey('k-1', text.length),
      staleMarker,
      orphanMarker,
    ])
    expect(entries.has('cache-entry:k-2')).toBe(true)
    expect(entries.has(storedCacheEntrySizeKey('k-2', text.length))).toBe(true)
    expect(entries.size).toBe(20)
  },
)

test('没有大小标记的旧条目按 0 字符计，但仍受条数上限约束', {}, async () => {
  // 有标记的 10 条正好 100 万字符；无标记的旧条目正文再长也不计入字符预算。
  const keys: string[] = []
  for (let index = 0; index < 10; index += 1) {
    keys.push(`cache-entry:k-${index}`)
    keys.push(storedCacheEntrySizeKey(`k-${index}`, 100_000))
  }
  keys.push('cache-entry:legacy')
  expect(excessCacheKeys(keys)).toEqual([])

  // 无标记条目仍占条目名额：301 条只淘汰最旧的一条。
  const many: string[] = []
  for (let index = 0; index < 301; index += 1) {
    many.push(`cache-entry:n-${index}`)
  }
  expect(excessCacheKeys(many)).toEqual(['cache-entry:n-0'])
})

test('按需读取表超过条数或字符上限时淘汰最旧结果', {}, async () => {
  // 条数上限：305 条短译文只保留最新的 300 条。
  const byCount = createStorageState()
  for (let index = 0; index < 305; index += 1) {
    rememberPersistedEntry(byCount, `k-${index}`, {
      status: 'translated',
      text: `译文 ${index}`,
    })
  }
  expect(byCount.persistedEntries.size).toBe(300)
  expect(byCount.persistedEntries.has('k-0')).toBe(false)
  expect(byCount.persistedEntries.has('k-4')).toBe(false)
  expect(byCount.persistedEntries.get('k-304')).toEqual({
    status: 'translated',
    text: '译文 304',
  })

  // 字符上限：12 × 10 万字符只保留最新的 10 条。
  const byChars = createStorageState()
  const longText = '字'.repeat(100_000)
  for (let index = 0; index < 12; index += 1) {
    rememberPersistedEntry(byChars, `k-${index}`, {
      status: 'translated',
      text: longText,
    })
  }
  expect(byChars.persistedEntries.size).toBe(10)
  expect(byChars.persistedEntries.has('k-0')).toBe(false)
  expect(byChars.persistedEntries.has('k-1')).toBe(false)
  expect(byChars.persistedEntries.get('k-11')).toBeDefined()

  // null（已确认缺失）不占字符预算，但仍占 300 条名额。
  const withNulls = createStorageState()
  for (let index = 0; index < 300; index += 1) {
    rememberPersistedEntry(withNulls, `missing-${index}`, null)
  }
  rememberPersistedEntry(withNulls, 'fresh', {
    status: 'translated',
    text: '新译文',
  })
  expect(withNulls.persistedEntries.size).toBe(300)
  expect(withNulls.persistedEntries.has('missing-0')).toBe(false)
  expect(withNulls.persistedEntries.get('fresh')).toEqual({
    status: 'translated',
    text: '新译文',
  })
})

test('持久化前只保留当前缓存里还存在的去重 key', {}, async () => {
  const entries: Record<string, { status: 'translated'; text: string }> = {}
  const persistedKeys = new Set<string>()
  for (let index = 0; index < 300; index += 1) {
    const key = `k-${index}`
    entries[key] = { status: 'translated', text: `译文 ${index}` }
    persistedKeys.add(key)
  }
  // 原子缓存淘汰了最旧的 5 条：对应去重 key 一并忘记。
  for (let index = 0; index < 5; index += 1) {
    delete entries[`k-${index}`]
  }

  retainPersistedKeys(persistedKeys, entries)

  expect(persistedKeys.size).toBe(295)
  expect(persistedKeys.has('k-0')).toBe(false)
  expect(persistedKeys.has('k-4')).toBe(false)
  expect(persistedKeys.has('k-5')).toBe(true)
  expect(persistedKeys.has('k-299')).toBe(true)
})

test(
  '长会话持久化时忘记已淘汰的去重 key，且不重写仍在缓存的译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    const bodyWrites: string[] = []
    on('store.get', ($inner, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($inner, e) => {
      stored.set(e.key, e.value)
      if (e.key.startsWith('cache-entry:')) bodyWrites.push(e.key)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是助手的回复。'))

    const source = (index: number) => `Reply ${index}.`
    const persistBatch = async (from: number, to: number) => {
      for (let index = from; index < to; index += 1) {
        await $.ui.render(assistantInput(source(index)))
      }
      await clock.advance(1)
      await clock.settle()
      await clock.advance(1000)
      await clock.settle()
    }

    // 第一批 200 条全部入库。
    await persistBatch(0, 200)
    expect(bodyWrites.length).toBe(200)

    // 第二批 150 条：原子缓存只留最新 300 条，最旧 50 条被淘汰。
    await persistBatch(200, 350)
    // 只写本批 150 条新译文，仍在新缓存里的前 150 条不重写。
    expect(bodyWrites.length).toBe(350)
    expect(bodyWrites.slice(200)).toEqual(
      Array.from({ length: 150 }, (_, offset) =>
        cacheEntryStoreKey(source(200 + offset)),
      ),
    )

    // 再翻一条：缓存里保留的译文仍不重写，只写新条目。
    await persistBatch(350, 351)
    expect(bodyWrites.length).toBe(351)
    expect(bodyWrites.at(-1)).toBe(cacheEntryStoreKey(source(350)))

    // 已淘汰的 key 重新回到缓存时应重新写入，说明去重集合确实忘了它。
    const reclaimedKey = cacheEntryStoreKey(source(0))
    stored.delete(reclaimedKey)
    stored.delete(cacheSizeStoreKey(source(0), '这是助手的回复。'.length))
    await persistBatch(0, 1)
    expect(bodyWrites.at(-1)).toBe(reclaimedKey)
    expect(stored.get(reclaimedKey)).toEqual({
      status: 'translated',
      text: '这是助手的回复。',
    })
  },
)

test(
  '持久化译文时写入大小标记且不碰旧版整表 cache 键',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    let legacyReads = 0
    let legacyWrites = 0
    on('store.get', ($inner, e) => {
      if (e.key === 'cache') legacyReads += 1
      return { value: stored.get(e.key) }
    })
    on('store.set', ($inner, e) => {
      if (e.key === 'cache') legacyWrites += 1
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是助手的回复。'))

    const source = 'This is the assistant reply.'
    const translatedText = '这是助手的回复。'
    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(stored.get(cacheEntryStoreKey(source))).toEqual({
      status: 'translated',
      text: translatedText,
    })
    expect(stored.get(cacheSizeStoreKey(source, translatedText.length))).toBe(
      translatedText.length,
    )
    // 旧版整表 'cache' 键仍然不读不写。
    expect(legacyReads).toBe(0)
    expect(legacyWrites).toBe(0)
  },
)

test(
  '大小标记写入失败时整条不记为已写，下次持久化补写',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    const writes: string[] = []
    let denyMarker = true
    on('store.get', ($inner, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($inner, e) => {
      writes.push(e.key)
      if (denyMarker && e.key.startsWith('cache-entry-size:')) {
        denyMarker = false
        return { deny: 'disk-full' }
      }
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    installModel(on, () => translated('这是本会话的译文。'))

    const firstSource = 'First reply with a failed size marker.'
    const laterSource = 'Later reply that triggers a retry.'
    const translatedText = '这是本会话的译文。'
    const firstKey = cacheEntryStoreKey(firstSource)
    const laterKey = cacheEntryStoreKey(laterSource)
    const firstSizeKey = cacheSizeStoreKey(firstSource, translatedText.length)
    const laterSizeKey = cacheSizeStoreKey(laterSource, translatedText.length)

    await $.ui.render(assistantInput(firstSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    // 正文写成功但标记失败：不能记为已写。
    expect(stored.get(firstKey)).toEqual({
      status: 'translated',
      text: translatedText,
    })
    expect(stored.has(firstSizeKey)).toBe(false)

    await $.ui.render(assistantInput(laterSource))
    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    expect(stored.get(firstSizeKey)).toBe(translatedText.length)
    expect(stored.get(laterSizeKey)).toBe(translatedText.length)
    expect(writes).toEqual([
      firstKey,
      firstSizeKey,
      firstKey,
      firstSizeKey,
      laterKey,
      laterSizeKey,
    ])
  },
)

test(
  '占位符缺失时保留原文并缓存失败',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(on, source => {
      const placeholders = source.match(/@@ST_KEEP_\d+@@/g) ?? []
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
  '响应始终不是严格 JSON 时重试一次后保留原文并缓存失败',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'not json')

    const source = 'This reply is not valid JSON.'
    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(2)

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(2)
  },
)

test(
  '首次回复不是严格 JSON 时自动重试并采用第二次译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    let calls = 0
    const prompts: string[] = []
    on('model.complete', ($model, e) => {
      calls += 1
      prompts.push(e.prompt)
      return {
        value: answered(
          calls === 1 ? 'not json' : translated('这是重试后的译文。'),
        ),
      }
    })

    const source = 'This reply is not valid JSON.'
    await $.ui.render(assistantInput(source))
    await clock.advance(1)
    await clock.settle()

    expect(calls).toBe(2)
    expect(prompts[1]).toContain('Escape every newline')

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe('这是重试后的译文。')
    expect(calls).toBe(2)
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
        protectedSource.match(/@@ST_KEEP_\d+@@/)?.[0] ?? ''
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

    const reply = await $.command.run(
      commandRunInput('translator', 'output en'),
    )
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
    await $.command.run(commandRunInput('translator', 'output ja'))

    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(1)

    // 切回中文后，旧 key 里必须是中文译文，而不是排队期间新设置的日文译文。
    await $.command.run(commandRunInput('translator', 'output zh'))
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

    await $.command.run(commandRunInput('btw', '解释一下这个函数'))

    expect(args).toContain('解释一下这个函数')
    expect(args).toContain('Answer in Simplified Chinese')
  },
)

test(
  'prompt.submit 放行斜杠命令不翻译，避免触发宿主警告',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => 'should not translate')
    let submitted = ''
    on('prompt.submit', ($, e) => {
      submitted = e.text
      return { text: e.text }
    })

    const line =
      '/pstack:poteto-mode 优化千牛登录流程的整体速度，现在用户点击登录后在工作台 -> 接待中心 的流程动作延迟很大'
    await $.prompt.submit({
      text: line,
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(0)
    expect(submitted).toBe(line)
  },
)

test(
  'prompt.submit 不误放行以斜杠开头的路径输入',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, source =>
      translated(`How to clean ${source.split(' ')[0]}`),
    )
    let submitted = ''
    on('prompt.submit', ($, e) => {
      submitted = e.text
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '/tmp/中文目录 怎么清理',
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(calls()).toBe(1)
    expect(submitted).toBe('How to clean /tmp/中文目录')
  },
)

test(
  'command.run 翻译斜杠命令参数并透传原命令名',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () =>
      translated('Optimize the overall speed of the Qianniu login flow'),
    )
    let receivedCommand = ''
    let receivedArgs = ''
    on('command.run', { command: 'pstack:poteto-mode' }, ($, e) => {
      receivedCommand = e.command
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(
      commandRunInput('pstack:poteto-mode', '优化千牛登录流程的整体速度'),
    )

    expect(calls()).toBe(1)
    expect(receivedCommand).toBe('pstack:poteto-mode')
    expect(receivedArgs).toBe(
      'Optimize the overall speed of the Qianniu login flow',
    )
  },
)

test(
  'command.run 跳过内置命令，不翻译其参数',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'rename' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('rename', '登录优化会话'))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe('登录优化会话')
  },
)

test(
  'command.run 对纯机器参数不调用模型也不改写参数',
  { options: { translateInput: true, inputLanguage: 'zh' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'custom:machine' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('custom:machine', '5m /review'))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe('5m /review')
  },
)

test(
  'command.run 自定义规则下机器参数仍不翻译',
  {
    options: {
      translateInput: true,
      inputLanguage: 'en',
      translationRules: '- 保留术语',
    },
  },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'custom:machine' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('custom:machine', '--fix'))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe('--fix')
  },
)

test(
  'command.run 机器参数与正文混排时仍翻译正文',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () =>
      translated('Optimize the login flow within 5 minutes'),
    )
    let receivedArgs = ''
    on('command.run', { command: 'pstack:poteto-mode' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(
      commandRunInput('pstack:poteto-mode', '5m 优化千牛登录流程'),
    )

    expect(calls()).toBe(1)
    expect(receivedArgs).toBe('Optimize the login flow within 5 minutes')
  },
)

test(
  'command.run 跳过 loop 命令，机器参数原样传递',
  { options: { translateInput: true, inputLanguage: 'zh' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'loop' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('loop', '5m /review'))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe('5m /review')
  },
)

test(
  'command.run 跳过 run 命令，普通命令参数原样传递',
  { options: { translateInput: true, inputLanguage: 'zh' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'run' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('run', 'npm test'))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe('npm test')
  },
)

test(
  'command.run 识别时长、相对路径、Windows 路径和 key=value 参数',
  { options: { translateInput: true, inputLanguage: 'zh' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not translate'))
    let receivedArgs = ''
    on('command.run', { command: 'custom:machine' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    const args = '2.5h ./x ../x C:\\x key=value'
    await $.command.run(commandRunInput('custom:machine', args))

    expect(calls()).toBe(0)
    expect(receivedArgs).toBe(args)
  },
)

test(
  'command.run 未知命令的普通单词参数仍翻译，序号不算时长',
  { options: { translateInput: true, inputLanguage: 'zh' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('运行测试'))
    let receivedArgs = ''
    on('command.run', { command: 'custom:machine' }, ($, e) => {
      receivedArgs = e.args
      return { text: '' }
    })

    await $.command.run(commandRunInput('custom:machine', '3rd npm test'))

    expect(calls()).toBe(1)
    expect(receivedArgs).toBe('运行测试')
  },
)

test(
  'command.run 翻译失败时取消执行并返回提示',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    on('model.complete', () => ({
      value: {
        isAnswered: false as const,
        reason: 'empty-reply' as const,
        usage: USAGE,
      },
    }))
    let ran = false
    on('command.run', { command: 'pstack:poteto-mode' }, () => {
      ran = true
      return { text: '' }
    })

    const reply = await $.command.run(
      commandRunInput('pstack:poteto-mode', '优化千牛登录流程'),
    )

    expect(ran).toBe(false)
    expect(reply.text).toContain('命令参数翻译失败')
  },
)

test(
  'translator status 显示当前设置',
  { options: { model: 'sonnet', inputLanguage: 'en', outputLanguage: 'zh' } },
  async ($, on) => {
    mock.store(on)

    const reply = await $.command.run(commandRunInput('translator', 'status'))

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

    const changed = await $.command.run(
      commandRunInput('translator', 'output en'),
    )
    expect(changed.text).toContain('outputLanguage=en')

    const reset = await $.command.run(commandRunInput('translator', 'reset'))
    expect(reset.text).toContain('outputLanguage=ja')
    expect(reset.text).toContain('model=sonnet')

    const status = await $.command.run(commandRunInput('translator', 'status'))
    expect(status.text).toContain('outputLanguage=ja')
    expect(status.text).toContain('model=sonnet')
  },
)

test(
  '持久化缓存里的失败条目按缺失处理，重新翻译后覆盖同一个键',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const source = 'This is the assistant reply.'
    const storeKey = cacheEntryStoreKey(source)
    const stored = new Map<string, unknown>([
      [storeKey, { status: 'failed', reason: 'malformed-response: x' }],
    ])
    on('store.get', ($inner, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($inner, e) => {
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => translated('这是助手的回复。'))

    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    await clock.advance(1000)
    await clock.settle()

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe('这是助手的回复。')
    expect(calls()).toBe(1)
    expect(stored.get(storeKey)).toEqual({
      status: 'translated',
      text: '这是助手的回复。',
    })
  },
)

test(
  '内存里的失败条目会重查 store，其他会话成功后重绘显示译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    // A 会话翻译失败后留下失败条目和负缓存；B 会话随后用同一个 key 成功持久化。
    // A 重绘不能一直被失败条目挡住，但也不能因此重新调用模型。
    const clock = mock.clock(on)
    const source = 'This reply fails to parse in this session.'
    const stored = new Map<string, unknown>()
    let storeKey: string | undefined
    let entryReads = 0
    on('store.get', ($inner, e) => {
      if (!e.key.startsWith('cache-entry:')) return { value: undefined }
      storeKey = e.key
      entryReads += 1
      return { value: stored.get(e.key) }
    })
    registerRenderBottoms(on)
    const calls = installModel(on, () => 'not json')

    // A：首次渲染未命中并记下缺失，翻译失败后失败条目留在内存里。
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(2)
    expect(storeKey).toBeDefined()
    expect(entryReads).toBe(1)

    // B 写入之前 A 再重绘：store 仍为空，重查后保留失败条目，不重新翻译。
    const early = await $.ui.render(assistantInput(source))
    expect(drawnText(early)).toBe(source)
    expect(entryReads).toBe(2)
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(2)

    // B 用 A 首次读取的同一个 key 成功翻译并持久化。
    stored.set(storeKey!, { status: 'translated', text: '其他会话的译文。' })

    // A 重绘：显示 B 的译文，模型调用次数不变。
    const recovered = await $.ui.render(assistantInput(source))
    expect(drawnText(recovered)).toBe('其他会话的译文。')
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(2)
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
    await $.session.start(sessionStartInput('.'))

    const reply = await $.command.run(commandRunInput('translator', 'status'))

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
    await $.session.start(sessionStartInput('.'))

    const reply = await $.command.run(commandRunInput('translator', 'status'))

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
    await $.session.start(sessionStartInput('.'))

    const reply = await $.command.run(commandRunInput('translator', 'status'))

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
  const pending = new Set<string>()
  let started = 0
  const start = () => {
    started += 1
  }
  const missing:
    | { after(delay: number, callback: () => void): unknown }
    | undefined = undefined

  expect(
    scheduleTranslation(
      callback => missing!.after(1, callback),
      key,
      start,
      pending,
    ),
  ).toBe('failed')
  expect(
    scheduleTranslation(
      () => {
        throw new Error('clock-unavailable')
      },
      key,
      start,
      pending,
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
      pending,
    ),
  ).toBe('scheduled')
  expect(started).toBe(0)
  queued[0]!()
  expect(started).toBe(1)
})

test('同一 key 已调度时返回 busy，不重复启动', {}, async () => {
  const key = 'schedule-busy-dedup'
  const pending = new Set<string>()
  let started = 0
  const start = () => {
    started += 1
  }
  const clock = (callback: () => void) => {
    callback()
  }

  expect(scheduleTranslation(clock, key, start, pending)).toBe('scheduled')
  expect(started).toBe(1)
  expect(scheduleTranslation(clock, key, start, pending)).toBe('busy')
  expect(started).toBe(1)
})

test(
  '读缓存期间切换输出语言，选择项译文仍按进入时的语言生成并复用同一个键',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    const shownQuestions: string[] = []

    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      const first = (e.questions as Array<Record<string, unknown>>)[0]
      shownQuestions.push(String(first?.question))
      return { result: { questions: e.questions, answers: {} } }
    })

    // 第一次读缓存条目时挂起，让测试在 await 窗口内切换输出语言。
    let entered = () => {}
    const enteredPromise = new Promise<void>(resolve => {
      entered = resolve
    })
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let firstEntryRead = true

    on('store.get', (_$inner, e) => {
      if (e.key.startsWith('cache-entry:') && firstEntryRead) {
        firstEntryRead = false
        entered()
        return gate.then(() => ({ value: undefined }))
      }
      return { value: undefined }
    })

    const systems: string[] = []
    const calls = installModel(on, (_source, system) => {
      systems.push(system)
      return system.includes('Japanese')
        ? '{"translations":["どのライブラリ？","ライブラリ","甲","最初の選択肢。","乙","二番目の選択肢。"]}'
        : '{"translations":["用哪个库？","库","甲","第一个选项。","乙","第二个选项。"]}'
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

    const pendingCall = $.tool.call({ tool: 'AskUserQuestion', questions })
    await enteredPromise

    try {
      const switched = await $.command.run(
        commandRunInput('translator', 'output ja'),
      )
      expect(switched.text).toContain('outputLanguage=ja')
    } finally {
      release()
    }
    await pendingCall

    // key 和译文参数来自同一份快照：模型收到的仍是中文提示，不是切换后的日文。
    expect(calls()).toBe(1)
    expect(systems[0]).toContain('into Simplified Chinese')
    expect(systems[0]).not.toContain('Japanese')
    expect(shownQuestions).toEqual(['用哪个库？'])

    await clock.advance(1)
    await clock.settle()

    // 切回中文再打开同一对话框：命中快照写入的缓存，不再调用模型。
    await $.command.run(commandRunInput('translator', 'output zh'))
    const second = await $.tool.call({ tool: 'AskUserQuestion', questions })
    expect(calls()).toBe(1)
    expect(shownQuestions).toEqual(['用哪个库？', '用哪个库？'])
    expect(
      (second as { result: { questions: unknown } }).result.questions,
    ).toEqual(questions)
  },
)

test(
  '永久 API 失败在回复渲染中写入内存缓存不重请求，在输入提交中也不二次重试',
  {
    options: {
      translateInput: true,
      inputLanguage: 'en',
      translateOutput: true,
      outputLanguage: 'zh',
    },
  },
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
          error: 'model_not_found' as const,
          status: 404,
          usage: USAGE,
        },
      }
    })

    const source = 'This reply hits a permanent model_not_found error.'
    const first = await $.ui.render(assistantInput(source))
    expect(drawnText(first)).toBe(source)

    await clock.advance(1)
    await clock.settle()
    expect(calls).toBe(1)

    const second = await $.ui.render(assistantInput(source))
    expect(drawnText(second)).toBe(source)
    await clock.advance(1)
    await clock.settle()
    expect(calls).toBe(1)

    const submitted = (await $.prompt.submit({
      text: '请帮我看看这个文件',
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string }
    expect(calls).toBe(2)
    expect(submitted.drop).toContain('api-error:model_not_found')
  },
)

test(
  'AskUserQuestion 选项说明为超过 20 字符的路径或 URL 且模型原样保留时仍正常显示译文',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    let asked: Array<Record<string, unknown>> = []
    on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => {
      asked = e.questions as Array<Record<string, unknown>>
      return { result: { questions: e.questions, answers: {} } }
    })

    const calls = installModel(
      on,
      () =>
        '{"translations":["查看哪个入口？","入口","鉴权模块","src/services/authentication.ts","官方文档","https://docs.anthropic.com/en/api"]}',
    )

    const questions = [
      {
        question: 'Which entry should we inspect?',
        header: 'Entry',
        multiSelect: false,
        options: [
          {
            label: 'Auth module',
            description: 'src/services/authentication.ts',
          },
          {
            label: 'Official docs',
            description: 'https://docs.anthropic.com/en/api',
          },
        ],
      },
    ]

    await $.tool.call({ tool: 'AskUserQuestion', questions })

    expect(calls()).toBe(1)
    expect(asked[0]?.question).toBe('查看哪个入口？')
    const options = asked[0]?.options as Array<Record<string, unknown>>
    expect(options[0]?.label).toBe('鉴权模块')
    expect(options[0]?.description).toBe('src/services/authentication.ts')
    expect(options[1]?.label).toBe('官方文档')
    expect(options[1]?.description).toBe('https://docs.anthropic.com/en/api')
  },
)

test(
  '下游 prompt.submit 丢弃提交时移除暂存原文，且 session.append 忽略非普通用户行',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    installModel(on, () => translated('OK'))
    let dropFirst = true
    on('prompt.submit', ($, e) => {
      if (dropFirst) {
        dropFirst = false
        return { drop: 'blocked' }
      }
      return { text: e.text }
    })

    const dropped = (await $.prompt.submit({
      text: '被拦截的第一条',
      wait: false,
      origin: { kind: 'composer' },
    })) as { drop?: string }
    expect(dropped.drop).toBe('blocked')

    await $.prompt.submit({
      text: '真正通过的第二条',
      wait: false,
      origin: { kind: 'composer' },
    })

    await $.session.append({
      message: {
        type: 'attachment',
        content: [{ type: 'text', text: 'OK' }],
      },
      door: 'user',
      origin: { kind: 'composer' },
      uuid: 'm-attachment',
    } as never)
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: true,
        content: [{ type: 'text', text: 'OK' }],
      },
      door: 'user',
      origin: { kind: 'composer' },
      uuid: 'm-meta',
    } as never)
    await $.session.append({
      message: {
        type: 'user',
        role: 'user',
        isMeta: false,
        content: [{ type: 'text', text: 'OK' }],
      },
      agentId: 'sub-1',
      door: 'user',
      origin: { kind: 'composer' },
      uuid: 'm-agent',
    } as never)

    await $.session.append(appendedUserMessage('OK', 'm-real') as never)

    const drawn = await $.ui.render(
      userMessageInput('OK', { kind: 'composer' }, 'm-real'),
    )
    expect(drawnText(drawn)).toBe('真正通过的第二条')
  },
)

test(
  'prompt.submit 跳过 isMeta 与结构化 command 提交，不调用模型',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not run'))
    const received: string[] = []
    on('prompt.submit', ($, e) => {
      received.push(e.text)
      return { text: e.text }
    })

    await $.prompt.submit({
      text: '展开后的技能中文提示',
      wait: false,
      isMeta: true,
      origin: { kind: 'composer' },
    } as never)
    await $.prompt.submit({
      text: '结构化命令中文提示',
      wait: false,
      command: { name: 'review', args: '' },
      origin: { kind: 'composer' },
    } as never)

    expect(calls()).toBe(0)
    expect(received).toEqual(['展开后的技能中文提示', '结构化命令中文提示'])
  },
)

test(
  'command.run 跳过非用户来源的命令调用',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    const calls = installModel(on, () => translated('should not run'))
    const seenArgs: string[] = []
    on('command.run', { command: 'custom:skill' }, ($, e) => {
      seenArgs.push(e.args)
      return { text: '' }
    })

    await $.command.run({
      ...commandRunInput('custom:skill', '插件传入的中文参数'),
      origin: { kind: 'plugin', name: 'other' } as never,
    })
    await $.command.run({
      ...commandRunInput('custom:skill', '定时触发的中文参数'),
      origin: { kind: 'scheduled-trigger' } as never,
    })

    expect(calls()).toBe(0)
    expect(seenArgs).toEqual(['插件传入的中文参数', '定时触发的中文参数'])
  },
)

test(
  'UserMessage 缓存 store 未命中避免重绘重复读取，且非用户来源不读 originals',
  { options: { translateInput: true, inputLanguage: 'en' } },
  async ($, on) => {
    registerRenderBottoms(on)
    let originalReads = 0
    on('store.get', (_$inner, e) => {
      if (e.key.startsWith('originals:')) originalReads += 1
      return { value: undefined }
    })

    const first = await $.ui.render(
      userMessageInput('Plain English message', { kind: 'composer' }, 'u-miss'),
    )
    const second = await $.ui.render(
      userMessageInput('Plain English message', { kind: 'composer' }, 'u-miss'),
    )
    expect(drawnText(first)).toBe('Plain English message')
    expect(drawnText(second)).toBe('Plain English message')
    expect(originalReads).toBe(1)

    const notification = await $.ui.render(
      userMessageInput(
        'Task notification text',
        { kind: 'task-notification' },
        'u-notify',
      ),
    )
    expect(drawnText(notification)).toBe('Task notification text')
    expect(originalReads).toBe(1)
  },
)

test(
  'translator-test 输出设置、配置行与 sonnet 回退结果，translator 持久化在修剪后仍失败时提示未持久化',
  { options: { model: 'haiku', outputLanguage: 'zh' } },
  async ($, on) => {
    on('config.list', () => ({
      value: [
        { key: 'session-translator.model', value: 'haiku', scope: 'user' },
        { key: 'other.key', value: 1, scope: 'user' },
      ] as never,
    }))

    const models: string[] = []
    on('model.complete', (_$inner, e) => {
      models.push(e.model ?? '')
      if (e.model === 'haiku') {
        return { value: answered('{"translation":"Hello world"}') }
      }
      return { value: answered('{"translation":"你好，世界"}') }
    })

    let pruneKeysCalls = 0
    on('store.keys', () => {
      pruneKeysCalls += 1
      return { value: ['originals:m-1'] }
    })
    on('store.delete', () => ({ value: undefined }))
    on('store.set', () => ({ deny: 'quota-exceeded' }))

    const testReply = await $.command.run(
      commandRunInput('translator-test', ''),
    )
    expect(models).toEqual(['haiku', 'sonnet'])
    expect(testReply.text).toContain('model=haiku')
    expect(testReply.text).toContain('session-translator.model="haiku"')
    expect(testReply.text).not.toContain('other.key')
    expect(testReply.text).toContain('model: haiku')
    expect(testReply.text).toContain('sonnet: {"translation":"你好，世界"}')

    const updateReply = await $.command.run(
      commandRunInput('translator', 'output ja'),
    )
    expect(pruneKeysCalls).toBe(1)
    expect(updateReply.text).toContain('已更新：outputLanguage=ja')
    expect(updateReply.text).toContain('（本次生效，未能持久化）')
  },
)

test(
  'session.start 在 store 无 settings 时回退到 initialOptions 并清理旧版 cache 键',
  { options: { outputLanguage: 'zh', model: 'haiku' } },
  async ($, on) => {
    const store = new Map<string, unknown>([
      ['cache', { old: { status: 'translated', text: '旧整表缓存' } }],
    ])
    const deleted: string[] = []
    on('store.get', (_$inner, e) => ({ value: store.get(e.key) }))
    on('store.keys', () => ({ value: [...store.keys()] }))
    on('store.delete', (_$inner, e) => {
      deleted.push(e.key)
      store.delete(e.key)
      return { value: undefined }
    })
    on('store.set', () => ({ deny: 'read-only' }))
    on('session.start', (_$inner, e) => e)

    const switched = await $.command.run(
      commandRunInput('translator', 'output ja'),
    )
    expect(switched.text).toContain('outputLanguage=ja')

    await $.session.start(sessionStartInput('.'))

    const status = await $.command.run(commandRunInput('translator', 'status'))
    expect(status.text).toContain('outputLanguage=zh')
    expect(deleted).toContain('cache')
    expect(store.has('cache')).toBe(false)
  },
)

test(
  '内存缓存淘汰后即使 store 写入失败也不重复调用模型重译',
  { options: { translateOutput: true, outputLanguage: 'zh' } },
  async ($, on) => {
    const clock = mock.clock(on)
    registerRenderBottoms(on)
    on('store.get', () => ({ value: undefined }))
    on('store.keys', () => ({ value: [] }))
    on('store.set', () => ({ deny: 'disk-full' }))

    const bigTranslation = '译'.repeat(95_000)
    const calls = installModel(on, () => translated(bigTranslation))
    const source = (index: number) => `Reply ${index} with a long translation.`

    for (let index = 0; index < 11; index += 1) {
      await $.ui.render(assistantInput(source(index)))
    }
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(11)

    await clock.advance(1000)
    await clock.settle()
    const rerendered = await $.ui.render(assistantInput(source(0)))
    expect(drawnText(rerendered)).toBe(bigTranslation)
    await clock.advance(1)
    await clock.settle()
    expect(calls()).toBe(11)
  },
)

test('rememberPersistedEntry 与 rememberOriginal 更新已有键时刷新淘汰顺序', {}, async () => {
  const state = createStorageState()
  rememberPersistedEntry(state, 'k-0', null)
  for (let index = 1; index < 300; index += 1) {
    rememberPersistedEntry(state, `k-${index}`, null)
  }
  rememberPersistedEntry(state, 'k-0', { status: 'translated', text: '新译文' })
  rememberPersistedEntry(state, 'k-300', null)
  expect(state.persistedEntries.has('k-0')).toBe(true)
  expect(state.persistedEntries.has('k-1')).toBe(false)

  for (let index = 0; index < 2000; index += 1) {
    rememberOriginal(state, `m-${index}`, null)
  }
  rememberOriginal(state, 'm-0', '找回的原文')
  expect(state.loadedOriginals.size).toBe(2000)
  expect(state.loadedOriginals.has('m-1')).toBe(true)
  rememberOriginal(state, 'm-2000', '新原文')
  expect(state.loadedOriginals.get('m-0')).toBe('找回的原文')
  expect(state.loadedOriginals.has('m-1')).toBe(false)
})
