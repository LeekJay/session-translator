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
import { contentText, goalConditionOf, replaceGoalCondition } from './goal'
import { containsTable, fitTables } from './tables'
import { PROMPT_TAG } from './prompt'
import {
  cacheKey,
  finalizeTranslation,
  isTransientFailure,
  isTranslationCache,
  mergeCaches,
  persistableCache,
  prepareTranslation,
  pruneCache,
  shouldTranslate,
  translationSignature,
} from './translate'
import type { TranslateOptions } from './translate'

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

const cache = atom(
  { plugin: 'session-translator', key: 'cache' } as const,
  {},
)

const pending = new Set<string>()

export type ScheduleResult = 'scheduled' | 'busy' | 'failed'

export type Schedule = (start: () => void) => unknown

// 同一 key 只排队一次；调度抛错时清掉 pending，下一次渲染还能重试。
export function scheduleTranslation(
  schedule: Schedule,
  key: string,
  start: () => void,
): ScheduleResult {
  if (pending.has(key)) return 'busy'
  pending.add(key)
  try {
    schedule(start)
    return 'scheduled'
  } catch {
    pending.delete(key)
    return 'failed'
  }
}

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
      persistedCache = persistableCache(saved)
      return persistedCache
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
        const merged = persistableCache(
          pruneCache(mergeCaches(persistedCache, entries)),
        )
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

export type Options = {
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

// settingsPayload 和 describeSettings 共用的键清单：直接从 DEFAULTS 派生。
// 加新设置时 Options 类型和 DEFAULTS 会先让编译器报错，这里无需再改。
export const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof Options)[]

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

// 两个入口共用同一份读取/回退逻辑：选项用 DEFAULTS 兜底，存储设置用当前值兜底。
function normalizeOptions(
  source: PluginOptions,
  fallback: Options,
): Options {
  const model = stringOption(source, 'model', fallback.model).trim()
  return {
    translateInput: booleanOption(
      source,
      'translateInput',
      fallback.translateInput,
    ),
    inputLanguage: languageOption(
      source,
      'inputLanguage',
      fallback.inputLanguage,
    ),
    translateOutput: booleanOption(
      source,
      'translateOutput',
      fallback.translateOutput,
    ),
    outputLanguage: languageOption(
      source,
      'outputLanguage',
      fallback.outputLanguage,
    ),
    model: model.length > 0 ? model : fallback.model,
    translationRules: stringOption(
      source,
      'translationRules',
      fallback.translationRules,
    ),
  }
}

function readOptions(options: PluginOptions): Options {
  return normalizeOptions(options, DEFAULTS)
}

export function applyStoredSettings(
  current: Options,
  saved: unknown,
): Options {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) {
    return current
  }

  return normalizeOptions(saved as PluginOptions, current)
}

export function settingsPayload(config: Options): Record<string, unknown> {
  return Object.fromEntries(
    SETTING_KEYS.map(key => [key, config[key]] as const),
  )
}

export function describeSettings(config: Options): string[] {
  return SETTING_KEYS.map(key =>
    key === 'translationRules'
      ? `translationRules=${
          config.translationRules.trim().length > 0
            ? config.translationRules
            : '(empty)'
        }`
      : `${key}=${config[key]}`,
  )
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
    // header 和选项标签很短，可能合法保留 API 这类拉丁词，因此跳过。
    for (let index = 0; index < translations.length; index += 1) {
      if (item.texts[index]!.length <= LONG_DIALOG_TEXT_LENGTH) continue
      if (!isUsableTranslation(translations[index]!, item.target)) {
        return { status: 'failed', reason: 'wrong-language' }
      }
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
      if (isUsableTranslation(translated, target, source.length)) {
        map.set(source, translated)
      }
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
  const runtime = {
    config: { ...initialOptions },
    signature: '',
  }
  runtime.signature = signatureOf(runtime.config)

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get('settings')
      const stored = applyStoredSettings(runtime.config, saved)
      runtime.config = stored
      runtime.signature = signatureOf(stored)
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
        runtime.signature = signatureOf(next)

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
        const next: Options = { ...initialOptions }
        runtime.config = next
        runtime.signature = signatureOf(next)

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
          `${languageName(runtime.config.inputLanguage)} translation of the user's message above:\n${entry.text}`,
        ],
      })
    } finally {
      safeStatus($, undefined)
    }
  }).catch(($, e, next) => next(e))

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
            entries[item.key] ?? (await readPersistedCache($))[item.key]

          if (entry?.status === 'translated') {
            rewritten = fitTables(entry.text, e.viewport?.columns)
          } else if (entry === undefined) {
            const outcome = scheduleTranslation(
              callback => $.clock.after(1, callback),
              item.key,
              () => run($, item),
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
}
