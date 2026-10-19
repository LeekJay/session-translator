import type { ModelCompleteResult } from 'claude-code'
import type {
  TranslationCache,
  TranslationCacheEntry,
  TranslationLanguage,
} from '../types'
import { detectSourceLanguage, isUsableTranslation } from './languages'
import {
  hasTranslatableProse,
  protectText,
  restoreText,
} from './protect'
import type { TranslationKind } from './prompt'
import { buildTranslationRequest, parseTranslationResponse } from './prompt'

export const MAX_CACHE_ENTRIES = 300

const TRANSIENT_FAILURES: readonly string[] = [
  'api-error',
  'empty-reply',
  'aborted',
]

export function isTransientFailure(reason: string): boolean {
  return TRANSIENT_FAILURES.some(prefix => reason.startsWith(prefix))
}

const PLACEHOLDER_PATTERN = /@@JXZ_TRANSLATION_\d+@@/g

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
}

export type TranslateOptions = {
  readonly text: string
  readonly target: TranslationLanguage
  readonly translationRules: string
  readonly model: string
  readonly kind: TranslationKind
  readonly signal?: AbortSignal
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
    ].join('\u0000'),
  )
}

export function cacheKey(
  signature: string,
  target: TranslationLanguage,
  text: string,
): string {
  return `${signature}:${target}:${fnv1a(text)}`
}

function isCacheEntry(value: unknown): value is TranslationCacheEntry {
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

export function isTranslationCache(value: unknown): value is TranslationCache {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every(isCacheEntry)
}

/**
 * 跨会话恢复：持久化的条目排在前面，本次会话已有的条目覆盖它们，
 * 这样 pruneCache 淘汰最久的一条时淘汰的是更早会话留下的。
 */
export function mergeCaches(
  saved: unknown,
  current: TranslationCache,
): TranslationCache {
  if (!isTranslationCache(saved)) return current
  return { ...saved, ...current }
}

export function pruneCache(cache: TranslationCache): TranslationCache {
  const keys = Object.keys(cache)
  if (keys.length <= MAX_CACHE_ENTRIES) return cache

  const kept: TranslationCache = {}
  for (const key of keys.slice(keys.length - MAX_CACHE_ENTRIES)) {
    const entry = cache[key]
    if (entry !== undefined) kept[key] = entry
  }
  return kept
}

export function shouldTranslate(
  text: string,
  target: TranslationLanguage,
  translationRules: string,
): boolean {
  if (text.trim().length === 0) return false
  if (text.trimStart().startsWith('/')) return false

  const protectedText = protectText(text)
  if (!hasTranslatableProse(protectedText.text)) return false

  const hasRules = translationRules.trim().length > 0
  if (!hasRules && detectSourceLanguage(text, target) === target) return false

  return true
}

function failed(reason: string): TranslationCacheEntry {
  return { status: 'failed', reason }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown-error'
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
    maxTokens: Math.min(
      16000,
      Math.max(4096, Math.ceil(options.text.length * 1.2)),
    ),
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
