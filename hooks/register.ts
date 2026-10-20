import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  ModelCompleteResult,
  PluginOptions,
  Register,
  RenderElement,
} from 'claude-code'
import type {
  TranslationCache,
  TranslationCacheEntry,
  TranslationLanguage,
} from '../types'
import {
  isTranslationLanguage,
  isUsableTranslation,
  languageName,
} from './languages'
import {
  buildAnswersRequest,
  buildQuestionsRequest,
  freeTextAnswers,
  parseQuestionsResponse,
  questionTexts,
  rewriteQuestions,
  translateAnswers,
} from './questions'
import { goalConditionContext, isGoalCondition } from './goal'
import { containsTable, fitTables } from './tables'
import {
  cacheKey,
  finalizeTranslation,
  isTransientFailure,
  isTranslationCache,
  mergeCaches,
  prepareTranslation,
  pruneCache,
  shouldTranslate,
  translationSignature,
} from './translate'
import type { TranslateOptions } from './translate'

const MAX_INPUT_LENGTH = 20_000

const TRANSLATABLE_ORIGINS: ReadonlySet<string> = new Set([
  'composer',
  'bridge',
  'sdk',
  'slack-ping',
  'unclassified',
])

const cache = atom(
  { plugin: 'session-translator', key: 'cache' } as const,
  {},
)

const originals = atom(
  { plugin: 'session-translator', key: 'originals' } as const,
  {},
)

const pending = new Set<string>()

const CACHE_STORE_KEY = 'cache'
const PERSIST_DELAY_MS = 1000

let persistScheduled = false
let persistedCache: TranslationCache | undefined

// 缓存本身在 $.state，只活一个会话；这里把它落到 $.store，--resume 时再装回来。
async function readPersistedCache(
  $: EngineInterface,
): Promise<TranslationCache> {
  if (persistedCache !== undefined) return persistedCache

  try {
    const saved = await $.store.get(CACHE_STORE_KEY)
    if (isTranslationCache(saved)) {
      persistedCache = saved
      return saved
    }
  } catch {
    // store 不可用时只影响跨会话复用，当前会话照常翻译。
  }
  return {}
}

function schedulePersist($: EngineInterface): void {
  if (persistScheduled) return
  persistScheduled = true

  try {
    $.clock.after(PERSIST_DELAY_MS, async () => {
      persistScheduled = false
      try {
        const entries = await read($, cache)
        const merged = pruneCache(mergeCaches(persistedCache, entries))
        persistedCache = merged
        await $.store.set(CACHE_STORE_KEY, merged)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'unknown-error'
        safeLog($, `翻译缓存持久化失败：${reason}`)
      }
    })
  } catch {
    persistScheduled = false
  }
}

type Options = {
  readonly translateInput: boolean
  readonly inputLanguage: TranslationLanguage
  readonly translateOutput: boolean
  readonly outputLanguage: TranslationLanguage
  readonly model: string
  readonly translationRules: string
}

const DEFAULTS: Options = {
  translateInput: true,
  inputLanguage: 'en',
  translateOutput: true,
  outputLanguage: 'zh',
  model: 'haiku',
  translationRules: '',
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

function booleanOption(
  options: PluginOptions,
  key: string,
  fallback: boolean,
): boolean {
  const value = options[key]
  return typeof value === 'boolean' ? value : fallback
}

function stringOption(
  options: PluginOptions,
  key: string,
  fallback: string,
): string {
  const value = options[key]
  return typeof value === 'string' ? value : fallback
}

function languageOption(
  options: PluginOptions,
  key: string,
  fallback: TranslationLanguage,
): TranslationLanguage {
  const value = options[key]
  return isTranslationLanguage(value) ? value : fallback
}

function readOptions(options: PluginOptions): Options {
  const model = stringOption(options, 'model', DEFAULTS.model).trim()
  return {
    translateInput: booleanOption(
      options,
      'translateInput',
      DEFAULTS.translateInput,
    ),
    inputLanguage: languageOption(
      options,
      'inputLanguage',
      DEFAULTS.inputLanguage,
    ),
    translateOutput: booleanOption(
      options,
      'translateOutput',
      DEFAULTS.translateOutput,
    ),
    outputLanguage: languageOption(
      options,
      'outputLanguage',
      DEFAULTS.outputLanguage,
    ),
    model: model.length > 0 ? model : DEFAULTS.model,
    translationRules: stringOption(
      options,
      'translationRules',
      DEFAULTS.translationRules,
    ),
  }
}

function applyStoredSettings(current: Options, saved: unknown): Options {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return current
  }

  const record = saved as PluginOptions
  const model = stringOption(record, 'model', current.model).trim()

  return {
    translateInput: booleanOption(
      record,
      'translateInput',
      current.translateInput,
    ),
    inputLanguage: languageOption(
      record,
      'inputLanguage',
      current.inputLanguage,
    ),
    translateOutput: booleanOption(
      record,
      'translateOutput',
      current.translateOutput,
    ),
    outputLanguage: languageOption(
      record,
      'outputLanguage',
      current.outputLanguage,
    ),
    model: model.length > 0 ? model : current.model,
    translationRules: stringOption(
      record,
      'translationRules',
      current.translationRules,
    ),
  }
}

function settingsPayload(config: Options): Record<string, unknown> {
  return {
    translateInput: config.translateInput,
    inputLanguage: config.inputLanguage,
    translateOutput: config.translateOutput,
    outputLanguage: config.outputLanguage,
    model: config.model,
    translationRules: config.translationRules,
  }
}

function describeSettings(config: Options): string[] {
  return [
    `translateInput=${config.translateInput}`,
    `inputLanguage=${config.inputLanguage}`,
    `translateOutput=${config.translateOutput}`,
    `outputLanguage=${config.outputLanguage}`,
    `model=${config.model}`,
    `translationRules=${
      config.translationRules.trim().length > 0
        ? config.translationRules
        : '(empty)'
    }`,
  ]
}

async function configRowsText($: EngineInterface): Promise<string> {
  try {
    const rows = (await $.config.list()).filter(row =>
      row.key.startsWith('session-translator.'),
    )
    return rows.length === 0
      ? 'config rows: none'
      : `config rows:\n${rows
          .map(row => `${row.key}=${JSON.stringify(row.value)}`)
          .join('\n')}`
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown-error'
    return `config rows: unavailable (${reason})`
  }
}

const USAGE_LINE =
  'usage: /translator [status|on|off|input <en|zh|ja|fr|de>|output <en|zh|ja|fr|de>|model <name>|rules <text>|reset]'

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

const HAN = /\p{Script=Han}/u

function usageLine(result: ModelCompleteResult): string {
  return `usage: out=${result.usage.output_tokens}, in=${result.usage.input_tokens}`
}

function describeCompletion(
  model: string,
  result: ModelCompleteResult,
): string {
  if (result.isAnswered) {
    return [
      `model: ${model}`,
      `reply: ${result.text}`,
      usageLine(result),
    ].join('\n')
  }
  return [`model: ${model}`, `reason: ${result.reason}`, usageLine(result)].join(
    '\n',
  )
}

function describeSonnet(result: ModelCompleteResult): string {
  return result.isAnswered
    ? `sonnet: ${result.text}\nsonnet ${usageLine(result)}`
    : `sonnet reason: ${result.reason}\nsonnet ${usageLine(result)}`
}

function needsSonnet(result: ModelCompleteResult): boolean {
  return !result.isAnswered || !HAN.test(result.text)
}

async function translate(
  $: EngineInterface,
  item: TranslateOptions,
): Promise<TranslationCacheEntry> {
  try {
    const prepared = prepareTranslation(item)
    const result = await $.model.complete(
      {
        model: item.model,
        prompt: prepared.prompt,
        system: prepared.system,
        maxTokens: prepared.maxTokens,
        effort: 'low',
      },
      item.signal === undefined ? undefined : { signal: item.signal },
    )
    if (!result.isAnswered) {
      return {
        status: 'failed',
        reason: `${result.reason} (out=${result.usage.output_tokens}, in=${result.usage.input_tokens})`,
      }
    }
    return finalizeTranslation(prepared, result)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown-error'
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
    // 存信封形态，读取时和模型原始回复走同一个解析器。
    return {
      status: 'translated',
      text: JSON.stringify({ translations }),
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown-error'
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
      if (isUsableTranslation(translated, target)) map.set(source, translated)
    }
  } catch {
    // 翻不动就让模型读原文，比丢掉答案安全。
  }

  return map
}

async function commit(
  $: EngineInterface,
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
    schedulePersist($)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown-error'
    safeLog($, `${label}翻译未写入缓存：${reason}`)
  } finally {
    pending.delete(key)
  }
}

function run($: EngineInterface, item: PendingTranslation): Promise<void> {
  return commit($, item.key, '回复', () =>
    translate($, {
      text: item.text,
      target: item.target,
      translationRules: item.translationRules,
      model: item.model,
      kind: 'output',
    }),
  )
}

export const register: Register = (on, options) => {
  const runtime = {
    config: readOptions(options),
    signature: '',
  }
  runtime.signature = translationSignature({
    inputLanguage: runtime.config.inputLanguage,
    outputLanguage: runtime.config.outputLanguage,
    model: runtime.config.model,
    translationRules: runtime.config.translationRules,
  })

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('settings')
      const stored = applyStoredSettings(runtime.config, saved)
      runtime.config = stored
      runtime.signature = translationSignature({
        inputLanguage: stored.inputLanguage,
        outputLanguage: stored.outputLanguage,
        model: stored.model,
        translationRules: stored.translationRules,
      })
    } catch {
      // 读取失败时沿用当前设置。
    }

    try {
      const savedCache = await readPersistedCache($)
      if (Object.keys(savedCache).length > 0) {
        await update($, cache, current =>
          pruneCache(mergeCaches(savedCache, current)),
        )
      }
    } catch {
      // 读取失败时从空缓存开始，回复照常翻译。
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
      const prompt =
        'Translate "Hello world" into Simplified Chinese. Return only {"translation":"..."}.'
      const request = { prompt, maxTokens: 4096, effort: 'low' as const }
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
      const reason = error instanceof Error ? error.message : 'unknown-error'
      return { text: `translator-test failed: ${reason}` }
    }
  })

  on('command.run', { command: 'translator' }, async ($, e) => {
    try {
      const apply = async (
        next: Options,
        reply: string,
      ): Promise<{ text: string }> => {
        runtime.config = next
        runtime.signature = translationSignature({
          inputLanguage: next.inputLanguage,
          outputLanguage: next.outputLanguage,
          model: next.model,
          translationRules: next.translationRules,
        })

        try {
          await $.store.set('settings', settingsPayload(next))
          return { text: reply }
        } catch {
          return { text: `${reply}\n（本次生效，未能持久化）` }
        }
      }

      const trimmed = e.args.trim()
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
      const verb = (match?.[1] ?? 'status').toLowerCase()
      const rest = match?.[2] ?? ''
      const current = runtime.config

      if (verb === 'status') {
        return {
          text: [...describeSettings(current), await configRowsText($)].join(
            '\n',
          ),
        }
      }

      if (verb === 'on' || verb === 'off') {
        const enabled = verb === 'on'
        return apply(
          {
            ...current,
            translateInput: enabled,
            translateOutput: enabled,
          },
          `已更新：translateInput=${enabled}, translateOutput=${enabled}`,
        )
      }

      if (verb === 'input' || verb === 'output') {
        const language = rest.trim()
        if (!isTranslationLanguage(language)) return { text: USAGE_LINE }

        return apply(
          verb === 'input'
            ? { ...current, inputLanguage: language }
            : { ...current, outputLanguage: language },
          `已更新：${verb}Language=${language}`,
        )
      }

      if (verb === 'model') {
        const model = rest.trim()
        if (model.length === 0) return { text: USAGE_LINE }
        return apply({ ...current, model }, `已更新：model=${model}`)
      }

      if (verb === 'rules') {
        const translationRules = rest.trim()
        return apply(
          { ...current, translationRules },
          translationRules.length === 0
            ? '已清空：translationRules'
            : `已更新：translationRules=${translationRules}`,
        )
      }

      if (verb === 'reset') {
        const next: Options = { ...DEFAULTS }
        runtime.config = next
        runtime.signature = translationSignature({
          inputLanguage: next.inputLanguage,
          outputLanguage: next.outputLanguage,
          model: next.model,
          translationRules: next.translationRules,
        })

        try {
          await $.store.delete('settings')
          return {
            text: `已重置：${describeSettings(next).join('，')}`,
          }
        } catch {
          return {
            text: `已重置：${describeSettings(next).join('，')}\n（本次生效，未能持久化）`,
          }
        }
      }

      return { text: USAGE_LINE }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown-error'
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

  on('prompt.submit', async ($, e, next) => {
    if (!runtime.config.translateInput) return next(e)

    const originKind = e.origin?.kind ?? 'unclassified'
    if (!TRANSLATABLE_ORIGINS.has(originKind)) return next(e)
    if (e.text.length > MAX_INPUT_LENGTH) return next(e)
    if (
      !shouldTranslate(
        e.text,
        runtime.config.inputLanguage,
        runtime.config.translationRules,
      )
    ) {
      return next(e)
    }

    safeStatus($, '翻译中…')
    try {
      const entry = await translate($, {
        text: e.text,
        target: runtime.config.inputLanguage,
        translationRules: runtime.config.translationRules,
        model: runtime.config.model,
        kind: 'input',
      })

      if (entry.status !== 'translated') {
        safeLog($, `提示翻译失败：${entry.reason}`)
        return next(e)
      }

      return next({
        ...e,
        context: [
          ...(e.context ?? []),
          `English translation of the user's message above:\n${entry.text}`,
        ],
      })
    } finally {
      safeStatus($, undefined)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    let rewritten: string | undefined

    try {
      if (runtime.config.translateOutput) {
        const source = e.props.text
        if (
          shouldTranslate(
            source,
            runtime.config.outputLanguage,
            runtime.config.translationRules,
          )
        ) {
          const key = cacheKey(
            runtime.signature,
            runtime.config.outputLanguage,
            source,
          )
          const entries = await read($, cache)
          const entry =
            entries[key] ?? (await readPersistedCache($))[key]

          if (entry?.status === 'translated') {
            rewritten = fitTables(entry.text, e.viewport?.columns)
          } else if (entry === undefined && !pending.has(key)) {
            pending.add(key)
            $.clock.after(1, () =>
              run($, {
                key,
                text: source,
                target: runtime.config.outputLanguage,
                translationRules: runtime.config.translationRules,
                model: runtime.config.model,
              }),
            )

            if (containsTable(source)) {
              // 表格消息不先画英文：终端已打印的行撤不回，等译文到了再换
              // 会把原文和译文叠在一起。先画一行占位符，译文到达后整块重绘。
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
            `tool-questions\u0000${JSON.stringify(texts)}`,
          )
          const entries = await read($, cache)
          let entry = entries[key] ?? (await readPersistedCache($))[key]

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
            } finally {
              pending.delete(key)
            }

            try {
              $.clock.after(1, () =>
                commit($, key, '选择项', async () => entry!),
              )
            } catch {
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

    if (translatedQuestions === undefined) return next(e)

    const result = await next({
      ...e,
      questions: translatedQuestions as typeof e.questions,
    })

    if (!('result' in result) || result.result === undefined) return result

    try {
      const freeText = await translateFreeTextAnswers(
        $,
        freeTextAnswers(result.result, e.questions, translatedQuestions),
        runtime.config.inputLanguage,
        runtime.config.translationRules,
        runtime.config.model,
      )
      return {
        ...result,
        result: translateAnswers(
          result.result,
          e.questions,
          translatedQuestions,
          freeText,
        ),
      }
    } catch {
      // 还原失败时宁可让模型看到译文，也不重复执行工具。
      return result
    }
  }).catch(($, e, next) => next(e))

  // `/goal` 的目标条件是用户原文，会同时进 Stop hook 的提示和目标状态条。
  // 这里不动参数：屏幕上那行、状态条、会话记录都保持原文，只在输出行之后
  // 附一条隐藏 context，让模型读得到英文译文。
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    try {
      if (!runtime.config.translateInput) return next(e)
      if (!isGoalCondition(e.args)) return next(e)
      if (
        !shouldTranslate(
          e.args,
          runtime.config.inputLanguage,
          runtime.config.translationRules,
        )
      ) {
        return next(e)
      }

      safeStatus($, '翻译中…')
      let translation: string | undefined
      try {
        const entry = await translate($, {
          text: e.args,
          target: runtime.config.inputLanguage,
          translationRules: runtime.config.translationRules,
          model: runtime.config.model,
          kind: 'input',
        })
        if (entry.status === 'translated') translation = entry.text
        else safeLog($, `目标翻译失败：${entry.reason}`)
      } finally {
        safeStatus($, undefined)
      }

      const result = await next(e)
      if (translation === undefined) return result
      return {
        ...result,
        context: [
          ...(result.context ?? []),
          goalConditionContext(translation),
        ],
      }
    } catch {
      return next(e)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    try {
      const kind = e.props.origin.kind
      if (kind !== 'composer' && kind !== 'bridge') return next(e)
      const map = await read($, originals)
      const original = map[e.props.text]
      if (original === undefined) return next(e)
      return next({ ...e, props: { ...e.props, text: original } })
    } catch {
      return next(e)
    }
  })
}
