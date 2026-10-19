import type { TranslationLanguage } from '../types'
import { languageName } from './languages'

type Record = { readonly [key: string]: unknown }

export const MAX_HEADER_LENGTH = 12

function isRecord(value: unknown): value is Record {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTranslatable(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function questionFields(question: Record): readonly unknown[] {
  return [
    question.question,
    question.header,
    question.description,
    question.placeholder,
  ]
}

// 标签也翻译：改写发生在 tool.call 的入参上，引擎画的就是改写后的入参，
// 不再走渲染 props 那条逐字比对标签的校验。答案回传前会映射回英文。
function optionFields(option: Record): readonly unknown[] {
  return [option.label, option.description]
}

/**
 * 对话框里要翻译的字符串，按渲染顺序排列：问题、标题、说明、占位符，
 * 然后是每个选项的标签和说明。预览内容原样保留。
 */
export function questionTexts(questions: unknown): string[] {
  const texts: string[] = []
  if (!Array.isArray(questions)) return texts

  for (const question of questions) {
    if (!isRecord(question)) continue
    for (const value of questionFields(question)) {
      if (isTranslatable(value)) texts.push(value)
    }
    if (!Array.isArray(question.options)) continue
    for (const option of question.options) {
      if (!isRecord(option)) continue
      for (const value of optionFields(option)) {
        if (isTranslatable(value)) texts.push(value)
      }
    }
  }

  return texts
}

/**
 * 只替换文本字段，其余字段（multiSelect、preview、min/max 等）逐个复制。
 * 数量对不上时返回 undefined，让引擎画原文，避免整块对话框变形。
 */
export function rewriteQuestions(
  questions: unknown,
  translated: readonly string[],
): unknown[] | undefined {
  if (!Array.isArray(questions)) return undefined

  let index = 0
  let matched = true

  const take = (value: string): string => {
    const next = translated[index]
    index += 1
    if (!isTranslatable(next)) {
      matched = false
      return value
    }
    return next
  }

  const rewritten = questions.map(question => {
    if (!isRecord(question)) return question

    const target: { [key: string]: unknown } = { ...question }

    if (isTranslatable(question.question)) {
      target.question = take(question.question)
    }
    if (isTranslatable(question.header)) {
      const header = take(question.header)
      // header 是芯片标签，超长会让引擎拒绝整块改写，保留原文更稳。
      target.header =
        header.length <= MAX_HEADER_LENGTH ? header : question.header
    }
    if (isTranslatable(question.description)) {
      target.description = take(question.description)
    }
    if (isTranslatable(question.placeholder)) {
      target.placeholder = take(question.placeholder)
    }

    if (Array.isArray(question.options)) {
      target.options = question.options.map(option => {
        if (!isRecord(option)) return option
        const optionCopy = { ...option } as { [key: string]: unknown }
        if (isTranslatable(option.label)) {
          optionCopy.label = take(option.label)
        }
        if (isTranslatable(option.description)) {
          optionCopy.description = take(option.description)
        }
        return optionCopy
      })
    }

    return target
  })

  if (!matched || index !== translated.length) return undefined
  return rewritten
}

export type QuestionsRequest = {
  readonly system: string
  readonly prompt: string
  readonly maxTokens: number
}

export function buildQuestionsRequest(
  texts: readonly string[],
  target: TranslationLanguage,
  rules: string,
): QuestionsRequest {
  const ruleLine =
    rules.trim().length > 0 ? `Additional rules:\n${rules.trim()}` : ''

  const system = [
    `You translate the interface strings of a multiple-choice dialog into ${languageName(target)}.`,
    'Return only strict JSON of the shape {"translations":[...]}.',
    'Keep the array the same length and order as the input array.',
    'Each entry is user-facing prose: natural, concise, and unambiguous.',
    'Keep headers at most 12 characters and option labels at most 16.',
    'End each question with a question mark.',
    'Never translate code, commands, file paths, URLs, or product names.',
    ruleLine,
  ]
    .filter(line => line.length > 0)
    .join('\n')

  const total = texts.reduce((sum, text) => sum + text.length, 0)
  const maxTokens = Math.min(16000, Math.max(4096, Math.ceil(total * 1.2)))

  return {
    system,
    prompt: JSON.stringify(texts),
    maxTokens,
  }
}

export function parseQuestionsResponse(raw: string): string[] | undefined {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return undefined
    const list = parsed.translations
    if (!Array.isArray(list) || list.length === 0) return undefined
    if (!list.every(item => isTranslatable(item))) return undefined
    return list as string[]
  } catch {
    return undefined
  }
}

function questionTextOf(question: unknown): string | undefined {
  if (!isRecord(question)) return undefined
  return isTranslatable(question.question) ? question.question : undefined
}

function answerMaps(
  original: readonly unknown[],
  translated: readonly unknown[],
): { questions: Map<string, string>; labels: Map<string, string> } {
  const questions = new Map<string, string>()
  const labels = new Map<string, string>()

  const count = Math.min(original.length, translated.length)
  for (let index = 0; index < count; index += 1) {
    const source = original[index]
    const drawn = translated[index]

    const sourceText = questionTextOf(source)
    const drawnText = questionTextOf(drawn)
    if (sourceText !== undefined && drawnText !== undefined) {
      questions.set(drawnText, sourceText)
    }

    if (!isRecord(source) || !isRecord(drawn)) continue
    const sourceOptions = Array.isArray(source.options) ? source.options : []
    const drawnOptions = Array.isArray(drawn.options) ? drawn.options : []
    const options = Math.min(sourceOptions.length, drawnOptions.length)
    for (let option = 0; option < options; option += 1) {
      const a = sourceOptions[option]
      const b = drawnOptions[option]
      if (!isRecord(a) || !isRecord(b)) continue
      if (isTranslatable(a.label) && isTranslatable(b.label)) {
        labels.set(b.label, a.label)
      }
    }
  }

  return { questions, labels }
}

/**
 * 把引擎按改写后入参生成的答案还原成原入参的语言：问题文本和选项标签
 * 换回英文，自由输入的文字保持不变。
 */
export function translateAnswers(
  result: unknown,
  original: readonly unknown[],
  translated: readonly unknown[],
): unknown {
  if (!isRecord(result)) return result

  const maps = answerMaps(original, translated)

  const restoreValue = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    const exact = maps.labels.get(value)
    if (exact !== undefined) return exact
    // 多选答案由引擎用 ", " 连接；逐段映射，认不出的原样保留。
    if (!value.includes(', ')) return value
    return value
      .split(', ')
      .map(part => maps.labels.get(part.trim()) ?? part)
      .join(', ')
  }

  const out: { [key: string]: unknown } = { ...result }
  out.questions = original

  if (isRecord(result.answers)) {
    out.answers = Object.fromEntries(
      Object.entries(result.answers).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        restoreValue(value),
      ]),
    )
  }

  if (isRecord(result.annotations)) {
    out.annotations = Object.fromEntries(
      Object.entries(result.annotations).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        value,
      ]),
    )
  }

  return out
}
