import type { TranslationLanguage } from '../types'

const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
  en: 'English',
  zh: 'Simplified Chinese',
  ja: 'Japanese',
  fr: 'French',
  de: 'German',
}

export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
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

const KANA = /[぀-ヿㇰ-ㇿ･-ﾟ]/
const HAN = /^\p{Script=Han}$/u
const LATIN = /^\p{Script=Latin}$/u
const PLACEHOLDER = /@@JXZ_TRANSLATION_\d+@@/g

function countScript(text: string, pattern: RegExp): number {
  let count = 0
  for (const char of text) {
    if (pattern.test(char)) count += 1
  }
  return count
}

// 目标语言不参与识别：这里只回答源文本是什么语言。
export function detectSourceLanguage(
  text: string,
  _target: TranslationLanguage,
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
  if (latin > 0 && han === 0) return 'en'
  return undefined
}

export function isUsableTranslation(
  text: string,
  language: TranslationLanguage,
  sourceProseLength = 0,
): boolean {
  const prose = text.replace(PLACEHOLDER, ' ').trim()
  if (prose.length === 0) return false

  if (sourceProseLength > 400 && prose.length < sourceProseLength * 0.3) {
    return false
  }

  const han = countScript(prose, HAN)
  const kana = countScript(prose, KANA)
  const latin = countScript(prose, LATIN)

  if (language === 'zh') return han > 0
  if (language === 'ja') return kana > 0 || han > 0
  return latin > 0 && latin >= han + kana
}
