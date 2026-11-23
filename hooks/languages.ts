import type { TranslationLanguage } from '../types'
import { PLACEHOLDER_PATTERN } from './protect'

const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
  fr: 'French',
  de: 'German',
}

const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  'en',
  'zh',
  'ja',
  'fr',
  'de',
]

export function languageName(language: TranslationLanguage): string {
  return LANGUAGE_NAMES[language]
}

export function isTranslationLanguage(
  value: unknown,
): value is TranslationLanguage {
  return (
    typeof value === 'string' &&
    (TRANSLATION_LANGUAGES as readonly string[]).includes(value)
  )
}

const KANA = /^[\p{Script=Hiragana}\p{Script=Katakana}]$/u
const HAN = /^\p{Script=Han}$/u
const LATIN = /^\p{Script=Latin}$/u

const LATIN_ACCENT = /[\u00C0-\u024F\u1E00-\u1EFF]/
const LATIN_WORD = /[\p{Script=Latin}]+/gu

// 法语和德语的常用虚词（排除 die、est 等常见英语词/缩写）。命中一个就说明不是英语，宁可多翻一次也不漏翻。
const NON_ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  'le', 'la', 'les', 'du', 'et', 'pas', 'pour', 'dans', 'avec',
  'sur', 'que', 'qui', 'je', 'tu', 'nous', 'vous', 'aux', 'une',
  'der', 'das', 'den', 'dem', 'des', 'und', 'ist', 'nicht',
  'mit', 'für', 'von', 'zu', 'ein', 'eine', 'ich', 'wir', 'sie',
  'auf', 'auch',
])

// 英语的常用功能词和动词。纯拉丁字母文本必须命中其中一个才判为英语；
// 一个都不命中就当作未知语言，宁可多翻一次也不漏翻。
const ENGLISH_MARKERS: ReadonlySet<string> = new Set([
  'the', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'in', 'on',
  'for', 'with', 'how', 'what', 'why', 'when', 'where', 'this', 'that',
  'these', 'those', 'please', 'can', 'could', 'should', 'would', 'run',
  'fix', 'review', 'explain', 'add', 'remove', 'update', 'check', 'make',
  'use', 'need',
])

function matchesAnyWord(text: string, words: ReadonlySet<string>): boolean {
  for (const word of text.toLowerCase().match(LATIN_WORD) ?? []) {
    if (words.has(word)) return true
  }
  return false
}

function hasNonEnglishSignal(text: string): boolean {
  return LATIN_ACCENT.test(text) || matchesAnyWord(text, NON_ENGLISH_MARKERS)
}

function hasEnglishSignal(text: string): boolean {
  return matchesAnyWord(text, ENGLISH_MARKERS)
}

function countScript(text: string, pattern: RegExp): number {
  let count = 0
  for (const char of text) {
    if (pattern.test(char)) count += 1
  }
  return count
}

// 目标语言不参与识别：这里只回答源文本是什么语言。拉丁字母不等于英语：
// 先排除带变音符号或命中法语/德语虚词的文本，再要求命中至少一个常见英语词。
// 判断不出时返回 undefined，调用方据此选择翻译而不是跳过——宁可多翻一次也不漏翻。
export function detectSourceLanguage(
  text: string,
): TranslationLanguage | undefined {
  let kana = 0
  let han = 0
  let latin = 0

  for (const char of text) {
    if (KANA.test(char)) kana += 1
    else if (HAN.test(char)) han += 1
    else if (LATIN.test(char)) latin += 1
  }

  if (kana > 0) return 'ja'
  if (han > 0 && han >= latin) return 'zh'
  if (latin > 0 && han === 0) {
    if (hasNonEnglishSignal(text)) return undefined
    return hasEnglishSignal(text) ? 'en' : undefined
  }
  return undefined
}

export function isUsableTranslation(
  text: string,
  language: TranslationLanguage,
  sourceProseLength = 0,
): boolean {
  const prose = text.replace(PLACEHOLDER_PATTERN, ' ').trim()
  if (prose.length === 0) return false

  const minRatio = language === 'zh' || language === 'ja' ? 0.15 : 0.3
  if (sourceProseLength > 400 && prose.length < sourceProseLength * minRatio) {
    return false
  }

  const han = countScript(prose, HAN)
  const kana = countScript(prose, KANA)
  const latin = countScript(prose, LATIN)

  if (language === 'zh') return han > 0
  if (language === 'ja') return kana > 0 || han > 0
  return latin > 0 && latin >= han + kana
}
