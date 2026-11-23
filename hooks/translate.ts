import type { ModelCompleteResult } from 'claude-code'
import type {
  TranslationCache,
  TranslationCacheEntry,
  TranslationLanguage,
} from '../types'
import { detectSourceLanguage, isUsableTranslation } from './languages'
import {
  PLACEHOLDER_PATTERN,
  hasTranslatableProse,
  protectText,
  restoreText,
} from './protect'
import type { TranslationKind } from './prompt'
import { buildTranslationRequest, parseTranslationResponse } from './prompt'

const MAX_CACHE_ENTRIES = 300

// 条目数之外再加总字符上限：一条助手回复可能上万字符，300 条长回复会让
// 插件内存和 store 达到数 MB。约 100 万字符（UTF-16 下约 2 MB）足够复用，
// 又不会无限增长。
export const MAX_CACHE_CHARS = 1_000_000

// 瞬时失败和可重试的解析失败都不写缓存：下一次遇到同样的文本会重新请求模型。
const TRANSIENT_FAILURES: readonly string[] = [
  'api-error:rate_limit',
  'api-error:overloaded',
  'api-error:server_error',
  'api-error:unknown',
  'api-error ',
  'empty-reply',
  'aborted',
  'unusable-questions',
]

export function isTransientFailure(reason: string): boolean {
  return (
    reason === 'api-error' ||
    TRANSIENT_FAILURES.some(prefix => reason.startsWith(prefix))
  )
}

export function formatUnanswered(
  result: Exclude<ModelCompleteResult, { isAnswered: true }>,
): string {
  const usage = `(out=${result.usage.output_tokens}, in=${result.usage.input_tokens})`
  if (result.reason === 'api-error') {
    return `api-error:${result.error} (status=${result.status ?? 'none'}, ${usage.slice(1)}`
  }
  return `${result.reason} ${usage}`
}

export type PreparedTranslation = {
  readonly system: string
  readonly prompt: string
  readonly maxTokens: number
  readonly sourceProseLength: number
  readonly values: readonly string[]
  readonly target: TranslationLanguage
}

export type SignatureInput = {
  readonly inputLanguage: TranslationLanguage
  readonly outputLanguage: TranslationLanguage
  readonly model: string
  readonly translationRules: string
  readonly promptVersion: string
}

export type CacheKeyKind = TranslationKind | 'questions'

export type TranslateOptions = {
  readonly text: string
  readonly target: TranslationLanguage
  readonly translationRules: string
  readonly model: string
  readonly kind: TranslationKind
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`
}

export function translationSignature(input: SignatureInput): string {
  return fnv1a(
    [
      input.inputLanguage,
      input.outputLanguage,
      input.model,
      input.translationRules,
      input.promptVersion,
    ].join('\u0000'),
  )
}

export function cacheKey(
  signature: string,
  target: TranslationLanguage,
  kind: CacheKeyKind,
  text: string,
): string {
  return `${signature}:${target}:${kind}:${fnv1a(text)}`
}

// 选择对话框的缓存键在共享签名（输入/输出语言、模型、规则、回复提示词版本）
// 之外再带上问题提示词版本：问题提示词单独演进，不能靠回复提示词版本兜底。
export function questionsCacheKey(
  signature: string,
  target: TranslationLanguage,
  promptVersion: string,
  texts: readonly string[],
): string {
  return cacheKey(
    signature,
    target,
    'questions',
    `${promptVersion}\u0000tool-questions\u0000${JSON.stringify(texts)}`,
  )
}

export function isCacheEntry(value: unknown): value is TranslationCacheEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as {
    readonly status?: unknown
    readonly text?: unknown
    readonly reason?: unknown
  }
  if (entry.status === 'translated') return typeof entry.text === 'string'
  if (entry.status === 'failed') return typeof entry.reason === 'string'
  return false
}

// 内存缓存和 store 修剪共用同一套淘汰边界。textLengths 按最旧到最新排列，
// 返回需要从头部淘汰的条数：失败条目传 0（不占字符预算，但仍占条目名额）。
export function excessCacheEntryCount(textLengths: readonly number[]): number {
  let totalChars = 0
  for (const length of textLengths) totalChars += length

  let dropCount = 0
  while (dropCount < textLengths.length) {
    const overEntries = textLengths.length - dropCount > MAX_CACHE_ENTRIES
    if (!overEntries && totalChars <= MAX_CACHE_CHARS) break
    totalChars -= textLengths[dropCount] ?? 0
    dropCount += 1
  }
  return dropCount
}

export function pruneCache(cache: TranslationCache): TranslationCache {
  const keys = Object.keys(cache)
  if (keys.length === 0) return cache

  const textLengths = keys.map(key => {
    const entry = cache[key]
    if (entry === undefined || entry.status !== 'translated') return 0
    return entry.text.length
  })
  const dropCount = excessCacheEntryCount(textLengths)
  if (dropCount === 0) return cache

  const kept: TranslationCache = {}
  for (const key of keys.slice(dropCount)) {
    const entry = cache[key]
    if (entry !== undefined) kept[key] = entry
  }
  return kept
}

// 只把 /命令 当命令跳过；/var/... 这类路径开头的正文照常翻译。
// 命令名可以带命名空间，例如 /pstack:poteto-mode。
const SLASH_COMMAND = /^\s*\/[A-Za-z][\w:-]*(?:\s|$)/

export function isSlashCommand(text: string): boolean {
  return SLASH_COMMAND.test(text)
}

// 纯 JSON 文档（对象或数组）按结构化数据处理，不翻译；JSON 后跟正文时
// JSON.parse 会失败，仍按普通正文处理。纯数字/字符串没有可翻译正文，
// 交给后面的规则。
function isJsonDocument(text: string): boolean {
  if (!text.startsWith('{') && !text.startsWith('[')) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// 没加围栏的裸代码：至少两行，且多数非空行以代码关键字开头或以 ; { } =>
// 结尾。围栏或行内代码已经变成占位符，不会把正文里的代码块算成整篇代码。
const CODE_KEYWORD =
  /^\s*(?:const|let|var|function|func|class|def|import|from|export|return|if|for|while|switch|try|catch|finally|async|await|public|private|protected|package|#include|using|fn|impl|struct|interface|enum|type|throw|new|case|break|continue|else|elif|do|val)\b/
const CODE_LINE_END = /(?:[;{}]|=>)\s*$/

function looksLikeCodeDocument(text: string): boolean {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length < 2) return false

  let codeLines = 0
  for (const line of lines) {
    if (CODE_KEYWORD.test(line) || CODE_LINE_END.test(line)) codeLines += 1
  }
  return codeLines * 2 > lines.length
}

export function shouldTranslate(
  text: string,
  target: TranslationLanguage,
): boolean {
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  if (isSlashCommand(trimmed)) return false
  if (isJsonDocument(trimmed)) return false

  const protectedText = protectText(text)
  if (!hasTranslatableProse(protectedText.text)) return false
  if (looksLikeCodeDocument(protectedText.text)) return false

  // 同语言跳过与自定义规则无关：规则约束的是译文措辞（术语、风格），
  // 不能把已经符合目标语言的文本再送去翻译一遍。
  const prose = protectedText.text.replace(PLACEHOLDER_PATTERN, ' ')
  if (detectSourceLanguage(prose) === target) return false

  return true
}

function failed(reason: string): TranslationCacheEntry {
  return { status: 'failed', reason }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown-error'
}

export function estimateMaxTokens(length: number): number {
  return Math.min(16000, Math.max(4096, Math.ceil(length * 1.2)))
}

export function prepareTranslation(
  options: TranslateOptions,
): PreparedTranslation {
  const protectedText = protectText(options.text)
  const request = buildTranslationRequest({
    text: protectedText.text,
    target: options.target,
    rules: options.translationRules,
    kind: options.kind,
  })

  return {
    system: request.system,
    prompt: request.prompt,
    maxTokens: estimateMaxTokens(options.text.length),
    // 只比较可翻译正文的长度；受保护片段在译文里只剩占位符，不能算进原文长度。
    sourceProseLength: protectedText.text
      .replace(PLACEHOLDER_PATTERN, ' ')
      .trim().length,
    values: protectedText.values,
    target: options.target,
  }
}

export function finalizeTranslation(
  prepared: PreparedTranslation,
  result: ModelCompleteResult,
): TranslationCacheEntry {
  try {
    if (!result.isAnswered) return failed(result.reason)

    const translation = parseTranslationResponse(result.text)
    if (translation === undefined) {
      return failed(`malformed-response: ${result.text.slice(0, 160)}`)
    }

    if (
      !isUsableTranslation(
        translation,
        prepared.target,
        prepared.sourceProseLength,
      )
    ) {
      return failed(`unusable-translation: ${translation.slice(0, 160)}`)
    }

    return {
      status: 'translated',
      text: restoreText(translation, prepared.values),
    }
  } catch (error) {
    return failed(describeError(error))
  }
}
