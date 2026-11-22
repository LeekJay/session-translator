import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type {
  TranslationCache,
  TranslationCacheEntry,
  TranslationLanguage,
} from '../types'
import { isUsableTranslation, languageName } from './languages'
import {
  buildAnswersRequest,
  buildQuestionsRequest,
  freeTextAnswers,
  parseQuestionsResponse,
  questionTexts,
  rewriteQuestions,
  translateAnswers,
} from './questions'
import { contentText, goalConditionOf, replaceGoalCondition } from './goal'
import { containsTable, fitTables } from './tables'
import { JSON_RETRY_PROMPT, PROMPT_TAG } from './prompt'
import {
  cacheKey,
  describeError,
  finalizeTranslation,
  isSlashCommand,
  isTransientFailure,
  mergeCaches,
  prepareTranslation,
  pruneCache,
  shouldTranslate,
  translationSignature,
} from './translate'
import type { TranslateOptions } from './translate'
import {
  CACHE_STORE_KEY,
  LEGACY_ORIGINALS_KEY,
  PERSIST_DELAY_MS,
  createStorageState,
  excessOriginalKeys,
  mergePersistedCache,
  parseLegacyOriginals,
  rememberOriginal,
  resolvePersistedCache,
  storedOriginalKey,
} from './storage'
import type { StorageState } from './storage'
import {
  SETTING_KEYS,
  SKIP_COMMAND_ARGS_TRANSLATION,
  TRANSLATOR_TEST_PROMPT,
  applyStoredSettings,
  describeCompletion,
  describeSettings,
  describeSonnet,
  formatConfigRows,
  needsSonnet,
  parseTranslatorCommand,
  readOptions,
  settingsPayload,
} from './commands'
import type { Options, RuntimeConfig } from './commands'

export type { Options }
export {
  SETTING_KEYS,
  applyStoredSettings,
  settingsPayload,
  describeSettings,
  isSlashCommand,
}

const cache = atom(
  { plugin: 'session-translator', key: 'cache' } as const,
  {},
)

const MAX_INPUT_LENGTH = 20_000

// 对话框里超过这个长度的文本是问题/说明，必须真的翻成目标语言。
const LONG_DIALOG_TEXT_LENGTH = 20

const TRANSLATABLE_ORIGINS: ReadonlySet<string> = new Set([
  'composer',
  'bridge',
  'sdk',
  'slack-ping',
  'unclassified',
])

async function translateInputWithRetry(
  $: EngineInterface,
  text: string,
  config: Options,
) {
  const request: TranslateOptions = {
    text,
    target: config.inputLanguage,
    translationRules: config.translationRules,
    model: config.model,
    kind: 'input',
  }
  let entry = await translate($, request)
  // 输入翻译失败会把原文交给主模型，违背替换模式；瞬时失败再试一次。
  if (entry.status !== 'translated' && isTransientFailure(entry.reason)) {
    entry = await translate($, request)
  }
  return entry
}

const defaultPending = new Set<string>()

type PendingInput = {
  readonly translated: string
  readonly original: string
}

const MAX_PENDING_INPUTS = 16

export type ScheduleResult = 'scheduled' | 'busy' | 'failed'

export type Schedule = (start: () => void) => unknown

// 同一 key 只排队一次；调度抛错时清掉 pending，下一次渲染还能重试。
export function scheduleTranslation(
  schedule: Schedule,
  key: string,
  start: () => void,
  pendingSet: Set<string> = defaultPending,
): ScheduleResult {
  if (pendingSet.has(key)) return 'busy'
  pendingSet.add(key)
  try {
    schedule(start)
    return 'scheduled'
  } catch {
    pendingSet.delete(key)
    return 'failed'
  }
}

type PendingTranslation = {
  readonly key: string
  readonly text: string
  readonly target: TranslationLanguage
  readonly translationRules: string
  readonly model: string
}

type PendingQuestions = {
  readonly key: string
  readonly texts: readonly string[]
  readonly target: TranslationLanguage
  readonly translationRules: string
  readonly model: string
}

function safeLog($: EngineInterface, message: string): void {
  try {
    $.ui.log(message)
  } catch {
    // 测试宿主或无界面的会话可能没有 $.ui，日志不是功能路径。
  }
}

function safeStatus($: EngineInterface, text: string | undefined): void {
  try {
    $.ui.status(text)
  } catch {
    // 测试宿主没有 ui.status；进度行不是功能路径。
  }
}

async function translate(
  $: EngineInterface,
  item: TranslateOptions,
): Promise<TranslationCacheEntry> {
  try {
    const prepared = prepareTranslation(item)
    const result = await $.model.complete({
      model: item.model,
      prompt: prepared.prompt,
      system: prepared.system,
      maxTokens: prepared.maxTokens,
      effort: 'low',
    })
    if (!result.isAnswered) {
      return {
        status: 'failed',
        reason: `${result.reason} (out=${result.usage.output_tokens}, in=${result.usage.input_tokens})`,
      }
    }
    const entry = finalizeTranslation(prepared, result)
    if (entry.status === 'translated') return entry
    if (!entry.reason.startsWith('malformed-response')) return entry

    // 一次格式纠正重试：多行或带引号的回复偶尔会返回截断/未转义的 JSON。
    const retry = await $.model.complete({
      model: item.model,
      prompt: `${prepared.prompt}\n\n${JSON_RETRY_PROMPT}`,
      system: prepared.system,
      maxTokens: prepared.maxTokens,
      effort: 'low',
    })
    if (!retry.isAnswered) {
      return {
        status: 'failed',
        reason: `${retry.reason} (out=${retry.usage.output_tokens}, in=${retry.usage.input_tokens})`,
      }
    }
    return finalizeTranslation(prepared, retry)
  } catch (error) {
    const reason = describeError(error)
    return { status: 'failed', reason }
  }
}

async function translateQuestions(
  $: EngineInterface,
  item: PendingQuestions,
): Promise<TranslationCacheEntry> {
  try {
    const request = buildQuestionsRequest(
      item.texts,
      item.target,
      item.translationRules,
    )
    const result = await $.model.complete({
      model: item.model,
      prompt: request.prompt,
      system: request.system,
      maxTokens: request.maxTokens,
      effort: 'low',
    })
    if (!result.isAnswered) {
      return {
        status: 'failed',
        reason: `${result.reason} (out=${result.usage.output_tokens}, in=${result.usage.input_tokens})`,
      }
    }

    const translations = parseQuestionsResponse(result.text)
    if (translations === undefined || translations.length !== item.texts.length) {
      return { status: 'failed', reason: 'unusable-questions' }
    }
    // header 和选项标签很短，可能合法保留 API 这类拉丁词，因此跳过。
    // 长条目还要比对原文长度：模型把长问题截成半句时宁可画原文。
    for (let index = 0; index < translations.length; index += 1) {
      const source = item.texts[index]!
      if (source.length <= LONG_DIALOG_TEXT_LENGTH) continue
      if (
        !isUsableTranslation(translations[index]!, item.target, source.length)
      ) {
        return { status: 'failed', reason: 'wrong-language' }
      }
    }
    // 存信封形态，读取时和模型原始回复走同一个解析器。
    return {
      status: 'translated',
      text: JSON.stringify({ translations }),
    }
  } catch (error) {
    const reason = describeError(error)
    return { status: 'failed', reason }
  }
}

/**
 * 用户手输的答案：选择对话框里选的是译好的中文标签，但输入框里打的是中文
 * 自由文本。回传前把这段自由文本送进模型翻成模型语言，翻不动就保留原文。
 * 逐条判语言，已经是模型语言的直接跳过。
 */
async function translateFreeTextAnswers(
  $: EngineInterface,
  texts: readonly string[],
  target: TranslationLanguage,
  translationRules: string,
  model: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (texts.length === 0) return map

  const pendingTexts = texts.filter(text =>
    shouldTranslate(text, target, translationRules),
  )
  if (pendingTexts.length === 0) return map

  try {
    const request = buildAnswersRequest(pendingTexts, target, translationRules)
    const result = await $.model.complete({
      model,
      prompt: request.prompt,
      system: request.system,
      maxTokens: request.maxTokens,
      effort: 'low',
    })
    if (!result.isAnswered) return map

    const translations = parseQuestionsResponse(result.text)
    if (translations === undefined) return map
    if (translations.length !== pendingTexts.length) return map

    for (let index = 0; index < pendingTexts.length; index += 1) {
      const source = pendingTexts[index]!
      const translated = translations[index]!
      if (isUsableTranslation(translated, target, source.length)) {
        map.set(source, translated)
      }
    }
  } catch {
    // 翻不动就让模型读原文，比丢掉答案安全。
  }

  return map
}

async function readPersistedCache(
  $: EngineInterface,
  storage: StorageState,
): Promise<TranslationCache> {
  if (storage.persistedCache !== undefined) return storage.persistedCache

  try {
    const saved = await $.store.get(CACHE_STORE_KEY)
    return resolvePersistedCache(storage, saved)
  } catch {
    // 读失败只是这一次失败，可能还有可复用缓存；不记忆空表，
    // 下次渲染再试，避免一次临时故障让整个会话都不再跨会话复用。
    return {}
  }
}

function schedulePersist($: EngineInterface, storage: StorageState): void {
  if (storage.persistScheduled) return
  storage.persistScheduled = true

  try {
    $.clock.after(PERSIST_DELAY_MS, async () => {
      storage.persistScheduled = false
      try {
        const entries = await read($, cache)
        let saved: unknown
        try {
          saved = await $.store.get(CACHE_STORE_KEY)
        } catch {
          // 读取失败时回退到内存中的 persistedCache
        }
        const merged = mergePersistedCache(storage, saved, entries)
        await $.store.set(CACHE_STORE_KEY, merged)
      } catch (error) {
        const reason = describeError(error)
        safeLog($, `翻译缓存持久化失败：${reason}`)
      }
    })
  } catch {
    storage.persistScheduled = false
  }
}

async function loadOriginalForMessage(
  $: EngineInterface,
  storage: StorageState,
  messageId: string,
): Promise<string | undefined> {
  const cached = storage.loadedOriginals.get(messageId)
  if (cached !== undefined) return cached

  let original: string | undefined
  try {
    const value = await $.store.get(storedOriginalKey(messageId))
    if (typeof value === 'string') {
      original = value
    }
  } catch {
    // store 读失败时尝试回退到旧版整表。
  }

  if (original === undefined) {
    original = storage.legacyOriginals[messageId]
  }
  if (original === undefined) return undefined

  rememberOriginal(storage, messageId, original)
  return original
}

async function saveOriginalForMessage(
  $: EngineInterface,
  storage: StorageState,
  messageId: string,
  original: string,
): Promise<void> {
  rememberOriginal(storage, messageId, original)
  try {
    await $.store.set(storedOriginalKey(messageId), original)
  } catch (error) {
    const reason = describeError(error)
    safeLog($, `原文映射持久化失败：${reason}`)
  }
}

async function configRowsText($: EngineInterface): Promise<string> {
  try {
    return formatConfigRows(await $.config.list())
  } catch (error) {
    const reason = describeError(error)
    return `config rows: unavailable (${reason})`
  }
}

async function commit(
  $: EngineInterface,
  storage: StorageState,
  pending: Set<string>,
  key: string,
  label: string,
  produce: () => Promise<TranslationCacheEntry>,
): Promise<void> {
  try {
    const entry = await produce()

    if (entry.status === 'failed') {
      safeLog($, `${label}翻译失败：${entry.reason}`)
      if (isTransientFailure(entry.reason)) {
        pending.delete(key)
        return
      }
    }

    await update($, cache, current => pruneCache({ ...current, [key]: entry }))
    if (entry.status === 'translated') schedulePersist($, storage)
  } catch (error) {
    const reason = describeError(error)
    safeLog($, `${label}翻译未写入缓存：${reason}`)
  } finally {
    pending.delete(key)
  }
}

function run(
  $: EngineInterface,
  storage: StorageState,
  pending: Set<string>,
  item: PendingTranslation,
): Promise<void> {
  return commit($, storage, pending, item.key, '回复', () =>
    translate($, {
      text: item.text,
      target: item.target,
      translationRules: item.translationRules,
      model: item.model,
      kind: 'output',
    }),
  )
}

function signatureOf(config: Options): string {
  return translationSignature({
    inputLanguage: config.inputLanguage,
    outputLanguage: config.outputLanguage,
    model: config.model,
    translationRules: config.translationRules,
    promptVersion: PROMPT_TAG,
  })
}

export const register: Register = (on, options) => {
  // reset 回到注册时读到的插件选项，而不是硬编码默认值。
  const initialOptions = readOptions(options)
  const runtime: RuntimeConfig = {
    config: { ...initialOptions },
    signature: '',
  }
  runtime.signature = signatureOf(runtime.config)

  const pending = new Set<string>()
  // prompt.submit 拿不到消息 ID；session.append 才带 uuid。提交时先记下译文与原文，
  // 落库时按文本匹配并绑定到消息 ID，查看时再按消息 ID 找回原文。
  // 排队提交时可能有多条同时等待落库，按先后顺序匹配；上限防止异常情况无限增长。
  const pendingInputs: PendingInput[] = []
  const storage: StorageState = createStorageState()

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('settings')
      const stored = applyStoredSettings(runtime.config, saved)
      runtime.config = stored
      runtime.signature = signatureOf(stored)
    } catch {
      // 读取失败时沿用当前设置。
    }

    storage.persistedCache = undefined
    try {
      const savedCache = await readPersistedCache($, storage)
      if (Object.keys(savedCache).length > 0) {
        await update($, cache, current =>
          pruneCache(mergeCaches(savedCache, current)),
        )
      }
    } catch {
      // 读取失败时从空缓存开始，回复照常翻译。
    }

    storage.loadedOriginals.clear()
    try {
      storage.legacyOriginals = parseLegacyOriginals(
        await $.store.get(LEGACY_ORIGINALS_KEY),
      )
    } catch {
      storage.legacyOriginals = {}
    }
    try {
      const keys = excessOriginalKeys(await $.store.keys())
      for (const key of keys) {
        await $.store.delete(key)
      }
    } catch {
      // store 不可用时只影响 --resume 后的原文显示。
    }

    try {
      await $.command.register({
        name: 'translator-test',
        description:
          'Call the translation model with a fixed sample and print its raw reply.',
      })
      await $.command.register({
        name: 'translator',
        description: '查看或修改翻译设置，设置会保存到本机。',
        argumentHint:
          '[status|on|off|input <en|zh|ja|fr|de>|output <en|zh|ja|fr|de>|model <name>|rules <text>|reset]',
      })
    } catch {
      // 宿主不开放命令注册时不影响翻译功能。
    }
    return next(e)
  })

  on('command.run', { command: 'translator-test' }, async $ => {
    try {
      const request = {
        prompt: TRANSLATOR_TEST_PROMPT,
        maxTokens: 4096,
        effort: 'low' as const,
      }
      const lines: string[] = [...describeSettings(runtime.config)]

      lines.push(await configRowsText($))

      const model = runtime.config.model
      const first = await $.model.complete({ ...request, model })
      lines.push(describeCompletion(model, first))

      if (model !== 'sonnet' && needsSonnet(first)) {
        const second = await $.model.complete({
          ...request,
          model: 'sonnet',
        })
        lines.push(describeSonnet(second))
      }

      return { text: lines.join('\n') }
    } catch (error) {
      const reason = describeError(error)
      return { text: `translator-test failed: ${reason}` }
    }
  })

  on('command.run', { command: 'translator' }, async ($, e) => {
    try {
      const action = parseTranslatorCommand(
        e.args,
        runtime.config,
        initialOptions,
      )

      if (action.kind === 'status') {
        return {
          text: [
            ...describeSettings(runtime.config),
            await configRowsText($),
          ].join('\n'),
        }
      }

      if (action.kind === 'reply') {
        return { text: action.text }
      }

      runtime.config = action.next
      runtime.signature = signatureOf(action.next)

      try {
        if (action.kind === 'reset') {
          await $.store.delete('settings')
        } else {
          await $.store.set('settings', settingsPayload(action.next))
        }
        return { text: action.reply }
      } catch {
        return { text: `${action.reply}\n（本次生效，未能持久化）` }
      }
    } catch (error) {
      const reason = describeError(error)
      return { text: `translator failed: ${reason}` }
    }
  })

  // /btw 的侧问面板由引擎绘制，没有可重写的渲染组件；
  // 只能改它收到的 args，让侧问模型直接用输出语言作答。
  on('command.run', { command: 'btw' }, ($, e, next) => {
    if (!runtime.config.translateOutput) return next(e)
    if (e.args.trim().length === 0) return next(e)
    return next({
      ...e,
      args: `${e.args}\n\nAnswer in ${languageName(runtime.config.outputLanguage)}.`,
    })
  }).catch(($, e, next) => next(e))

  // 斜杠命令在 prompt.submit 阶段改写不会生效；改在这里翻译其参数。
  on('command.run', async ($, e, next) => {
    if (!runtime.config.translateInput) return next(e)
    if (SKIP_COMMAND_ARGS_TRANSLATION.has(e.command)) return next(e)
    if (e.args.trim().length === 0) return next(e)
    if (
      !shouldTranslate(
        e.args,
        runtime.config.inputLanguage,
        runtime.config.translationRules,
      )
    ) {
      return next(e)
    }
    if (e.args.length > MAX_INPUT_LENGTH) {
      return {
        text: '命令参数过长（超过 20000 字符），未能翻译。请缩短后重试。',
      }
    }

    safeStatus($, '翻译中…')
    try {
      const entry = await translateInputWithRetry($, e.args, runtime.config)
      if (entry.status !== 'translated') {
        safeLog($, `命令参数翻译失败，已取消执行：${entry.reason}`)
        return { text: `命令参数翻译失败，已取消执行：${entry.reason}` }
      }
      return next({ ...e, args: entry.text })
    } finally {
      safeStatus($, undefined)
    }
  }).catch(($, e, next) => {
    safeLog($, '命令参数翻译异常，已取消执行')
    return { text: '命令参数翻译异常，已取消执行' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!runtime.config.translateInput) return next(e)

    const originKind = e.origin?.kind ?? 'unclassified'
    if (!TRANSLATABLE_ORIGINS.has(originKind)) return next(e)
    // 宿主会忽略 prompt.submit 对斜杠命令的改写并发出警告，命令参数改由 command.run 处理。
    if (isSlashCommand(e.text)) return next(e)
    if (
      !shouldTranslate(
        e.text,
        runtime.config.inputLanguage,
        runtime.config.translationRules,
      )
    ) {
      return next(e)
    }
    // 这段文本本该翻译，放行原文会把它交给主模型，违背替换模式；只能丢弃。
    if (e.text.length > MAX_INPUT_LENGTH) {
      return { drop: '提示过长（超过 20000 字符），未能翻译。请拆成几段后重试。' }
    }

    safeStatus($, '翻译中…')
    try {
      const entry = await translateInputWithRetry($, e.text, runtime.config)

      if (entry.status !== 'translated') {
        // 回退原文会把它交给主模型，违背替换模式；丢弃提交，引擎会把原文放回输入框。
        safeLog($, `提示翻译失败，已丢弃提交：${entry.reason}`)
        return { drop: `提示翻译失败，原文已放回输入框：${entry.reason}` }
      }

      pendingInputs.push({ translated: entry.text, original: e.text })
      if (pendingInputs.length > MAX_PENDING_INPUTS) pendingInputs.shift()
      return next({ ...e, text: entry.text })
    } finally {
      safeStatus($, undefined)
    }
  }).catch(($, e, next) => {
    safeLog($, '提示翻译异常，已丢弃提交')
    return { drop: '提示翻译异常，原文已放回输入框' }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    let rewritten: string | undefined

    try {
      // 排队翻译期间设置可能改变；key 和译文参数必须来自同一份快照。
      const config = runtime.config
      const signature = runtime.signature
      if (config.translateOutput) {
        const source = e.props.text
        if (
          shouldTranslate(
            source,
            config.outputLanguage,
            config.translationRules,
          )
        ) {
          const item: PendingTranslation = {
            key: cacheKey(signature, config.outputLanguage, 'output', source),
            text: source,
            target: config.outputLanguage,
            translationRules: config.translationRules,
            model: config.model,
          }
          const entries = await read($, cache)
          const entry =
            entries[item.key] ??
            (await readPersistedCache($, storage))[item.key]

          if (entry?.status === 'translated') {
            rewritten = fitTables(entry.text, e.viewport?.columns)
          } else if (entry === undefined) {
            const outcome = scheduleTranslation(
              callback => $.clock.after(1, callback),
              item.key,
              () => run($, storage, pending, item),
              pending,
            )
            if (outcome === 'failed') return next(e)

            if (containsTable(source)) {
              // 表格消息不先画英文：终端已打印的行撤不回，等译文到了再换
              // 会把原文和译文叠在一起。先画一行占位符，译文到达后整块重绘。
              // 翻译未完成时引擎可能重绘，这里也要继续画占位符。
              const { Text } = $.ui.resolve(e)
              return h(Text, { dimColor: true }, '翻译中…') as RenderElement
            }
          }
        }
      }
    } catch {
      return next(e)
    }

    return rewritten === undefined
      ? next(e)
      : next({ ...e, props: { ...e.props, text: rewritten } })
  })

  // 输入翻译把用户消息替换成了译文，记录和模型历史都是译文。
  // 引擎把 UserMessage 的 requestId 设为消息 ID，和 session.append 的 uuid 一致；
  // 查看时按它把原文换回来。直接读会话文件的工具仍会看到译文。
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    try {
      const messageId = e.requestId
      if (typeof messageId !== 'string') return next(e)

      const original = await loadOriginalForMessage($, storage, messageId)
      if (original === undefined) return next(e)

      return next({ ...e, props: { ...e.props, text: original } })
    } catch {
      return next(e)
    }
  })

  // 选择对话框由引擎直接画工具入参。在 tool.call 阶段改写入参，引擎校验的
  // 就是改写后的入参，因此选项标签也能翻成中文；答案回传前再映射回英文，
  // 模型始终看到英文。首次打开会等模型几秒，之后走缓存。
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    let translatedQuestions: unknown[] | undefined

    try {
      if (runtime.config.translateOutput) {
        const source = e.questions
        const texts = questionTexts(source)

        if (
          texts.length > 0 &&
          shouldTranslate(
            texts.join('\n'),
            runtime.config.outputLanguage,
            runtime.config.translationRules,
          )
        ) {
          const key = cacheKey(
            runtime.signature,
            runtime.config.outputLanguage,
            'questions',
            `tool-questions\u0000${JSON.stringify(texts)}`,
          )
          const entries = await read($, cache)
          let entry =
            entries[key] ?? (await readPersistedCache($, storage))[key]

          if (entry === undefined && !pending.has(key)) {
            pending.add(key)
            try {
              entry = await translateQuestions($, {
                key,
                texts,
                target: runtime.config.outputLanguage,
                translationRules: runtime.config.translationRules,
                model: runtime.config.model,
              })
            } catch (error) {
              pending.delete(key)
              throw error
            }

            try {
              $.clock.after(1, () =>
                commit($, storage, pending, key, '选择项', async () => entry!),
              )
            } catch {
              pending.delete(key)
              // 没有时钟的宿主仍然能显示这次译文，只是不缓存。
            }
          }

          if (entry?.status === 'translated') {
            const translations = parseQuestionsResponse(entry.text)
            if (translations !== undefined) {
              translatedQuestions = rewriteQuestions(source, translations)
            }
          }
        }
      }
    } catch {
      translatedQuestions = undefined
    }

    // 输入翻译只决定用户写的自由文本要不要变成模型语言；
    // 问题/选项的改写仍由 translateOutput 控制。
    if (
      translatedQuestions === undefined &&
      !runtime.config.translateInput
    ) {
      return next(e)
    }

    const result =
      translatedQuestions === undefined
        ? await next(e)
        : await next({
            ...e,
            questions: translatedQuestions as typeof e.questions,
          })

    if (!('result' in result) || result.result === undefined) return result

    try {
      const drawnQuestions = translatedQuestions ?? e.questions
      const freeText = runtime.config.translateInput
        ? await translateFreeTextAnswers(
            $,
            freeTextAnswers(result.result, e.questions, drawnQuestions),
            runtime.config.inputLanguage,
            runtime.config.translationRules,
            runtime.config.model,
          )
        : new Map<string, string>()

      return {
        ...result,
        result: translateAnswers(
          result.result,
          e.questions,
          drawnQuestions,
          freeText,
        ),
      }
    } catch {
      // 还原失败时宁可让模型看到译文，也不重复执行工具。
      return result
    }
  }).catch(($, e, next) => next(e))

  // `/goal` 走的是 local-jsx 面板分支，不经过 `command.run`；引擎在设置目标后
  // 追加一条 `door=note` 的 meta 行把条件念给模型听。那条行只给模型看，屏幕上
  // 显示的是 `Goal set: …` 输出行和底部状态条，二者都用用户原文，所以在这里
  // 把行里的条件换成译文即可，输入、会话记录和目标状态都不受影响。
  on('session.append', { door: 'note' }, async ($, e, next) => {
    try {
      if (!runtime.config.translateInput) return next(e)
      const content = e.message.content
      // note 只有一个 text block 时才能整行替换；多个块会把整行复制到每个块。
      if (Array.isArray(content)) {
        const textBlocks = content.filter(
          block =>
            typeof block === 'object' &&
            block !== null &&
            (block as { type?: string }).type === 'text',
        )
        if (textBlocks.length !== 1) return next(e)
      }
      const text = contentText(content)
      if (text === undefined) return next(e)

      const condition = goalConditionOf(text)
      if (condition === undefined) return next(e)
      if (
        !shouldTranslate(
          condition,
          runtime.config.inputLanguage,
          runtime.config.translationRules,
        )
      ) {
        return next(e)
      }

      const entry = await translate($, {
        text: condition,
        target: runtime.config.inputLanguage,
        translationRules: runtime.config.translationRules,
        model: runtime.config.model,
        kind: 'input',
      })
      if (entry.status !== 'translated') {
        safeLog($, `目标条件翻译失败：${entry.reason}`)
        return next(e)
      }

      const rewritten = replaceGoalCondition(text, entry.text)
      return next({
        ...e,
        message: {
          ...e.message,
          content: Array.isArray(content)
            ? content.map(block =>
                block.type === 'text' ? { ...block, text: rewritten } : block,
              )
            : [{ type: 'text', text: rewritten }],
        },
      })
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  // 用户消息落库时才能拿到消息 ID。把提交时暂存的原文按译文匹配，
  // 再绑定到这条消息的 uuid；查看时按同一个 ID 显示原文。
  on('session.append', async ($, e, next) => {
    try {
      const originKind = e.origin?.kind ?? 'unclassified'
      if (!TRANSLATABLE_ORIGINS.has(originKind)) return next(e)

      const messageId = e.uuid
      if (typeof messageId !== 'string' || messageId.length === 0) {
        return next(e)
      }
      const rawContent = e.message.content
      const text = contentText(
        Array.isArray(rawContent)
          ? rawContent.filter(
              block =>
                typeof block === 'object' &&
                block !== null &&
                (block as { type?: string }).type === 'text',
            )
          : rawContent,
      )
      if (text === undefined) return next(e)

      const index = pendingInputs.findIndex(
        item => item.translated.trim() === text.trim(),
      )
      if (index === -1) return next(e)

      const item = pendingInputs.splice(index, 1)[0]
      if (item === undefined) return next(e)

      await saveOriginalForMessage($, storage, messageId, item.original)
    } catch {
      // 映射失败只影响查看；记录和翻译本身不受影响。
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
