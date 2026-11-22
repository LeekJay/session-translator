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

// 引擎的 annotation 值是对象；只有 notes 是用户手输的自由文本。
function annotationNotes(value: Record): string | undefined {
  return isTranslatable(value.notes) ? value.notes : undefined
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

/**
 * 用户在选择对话框里手输的答案，回传给模型前也要变成模型语言。
 * 输入是一组独立答案，输出顺序与之一一对应，不加长度限制。
 */
export function buildAnswersRequest(
  texts: readonly string[],
  target: TranslationLanguage,
  rules: string,
): QuestionsRequest {
  const ruleLine =
    rules.trim().length > 0 ? `Additional rules:\n${rules.trim()}` : ''

  const system = [
    `You translate answers a person typed into a multiple-choice dialog, into ${languageName(target)}.`,
    'Return only strict JSON of the shape {"translations":[...]}.',
    'Keep the array the same length and order as the input array.',
    'Each entry is one complete answer. Preserve its meaning exactly; do not shorten, merge, or split it.',
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
): {
  questions: Map<string, string>
  labels: Map<string, string>
  labelsByQuestion: Map<string, Map<string, string>>
} {
  const questions = new Map<string, string>()
  const labels = new Map<string, string>()
  const labelsByQuestion = new Map<string, Map<string, string>>()
  // 合并映射只给无问题归属的 response 用。同一译名在不同问题指向不同原文时
  // 无法判断它属于哪道题，移除它，让 response 按自由文本处理。
  const ambiguousLabels = new Set<string>()

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
    const questionLabels = new Map<string, string>()
    for (let option = 0; option < options; option += 1) {
      const a = sourceOptions[option]
      const b = drawnOptions[option]
      if (!isRecord(a) || !isRecord(b)) continue
      if (isTranslatable(a.label) && isTranslatable(b.label)) {
        questionLabels.set(b.label, a.label)
        if (!ambiguousLabels.has(b.label)) {
          const existing = labels.get(b.label)
          if (existing === undefined || existing === a.label) {
            labels.set(b.label, a.label)
          } else {
            labels.delete(b.label)
            ambiguousLabels.add(b.label)
          }
        }
      }
    }
    if (sourceText !== undefined) {
      labelsByQuestion.set(sourceText, questionLabels)
    }
  }

  return { questions, labels, labelsByQuestion }
}

function answerParts(value: unknown): string[] {
  if (typeof value !== 'string') return []
  // 多选答案由引擎用 ", " 连接。
  return value
    .split(', ')
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

/**
 * 把一条答案拆成有序的片段：命中的选项标签各占一段，连续的手输文字并成
 * 一段。手输段按 ", " 拆开再拼回，用户自己打的逗号因此不会被吞掉。
 */
type AnswerSegment =
  | { readonly kind: 'label'; readonly text: string }
  | { readonly kind: 'free'; readonly text: string }

function splitAnswer(
  value: unknown,
  labels: ReadonlyMap<string, string>,
): AnswerSegment[] {
  const segments: AnswerSegment[] = []
  let free: string[] = []

  const flushFree = (): void => {
    if (free.length === 0) return
    segments.push({ kind: 'free', text: free.join(', ') })
    free = []
  }

  for (const part of answerParts(value)) {
    const label = labels.get(part)
    if (label !== undefined) {
      flushFree()
      segments.push({ kind: 'label', text: label })
    } else {
      free.push(part)
    }
  }
  flushFree()

  return segments
}

/**
 * 用户手输的自由答案：既不在选项标签里，也不是问题文本本身。
 * 这些文字和选项标签一样要变成模型语言，返回去重后的待译文案。
 */
export function freeTextAnswers(
  result: unknown,
  original: readonly unknown[],
  translated: readonly unknown[],
): string[] {
  if (!isRecord(result)) return []

  const maps = answerMaps(original, translated)
  const texts: string[] = []

  // 答案按所属问题取标签映射；同一译名在两道题出现时不会互相覆盖。
  const labelsFor = (key: string): ReadonlyMap<string, string> => {
    const originalQuestion = maps.questions.get(key) ?? key
    return maps.labelsByQuestion.get(originalQuestion) ?? maps.labels
  }

  const push = (
    value: unknown,
    labels: ReadonlyMap<string, string>,
  ): void => {
    for (const segment of splitAnswer(value, labels)) {
      if (segment.kind !== 'free') continue
      if (texts.includes(segment.text)) continue
      texts.push(segment.text)
    }
  }

  if (isRecord(result.answers)) {
    for (const [key, value] of Object.entries(result.answers)) {
      push(value, labelsFor(key))
    }
  }
  if (isRecord(result.annotations)) {
    for (const [key, value] of Object.entries(result.annotations)) {
      const labels = labelsFor(key)
      if (!isRecord(value)) {
        push(value, labels)
        continue
      }
      const notes = annotationNotes(value)
      if (notes !== undefined) push(notes, labels)
    }
  }
  push(result.response, maps.labels)

  return texts
}

/**
 * 把引擎按改写后入参生成的答案还原成原入参的语言：问题文本和选项标签
 * 换回英文；用户手输的自由答案用 freeText 映射成英文，映射不到的保留原文。
 */
export function translateAnswers(
  result: unknown,
  original: readonly unknown[],
  translated: readonly unknown[],
  freeText: ReadonlyMap<string, string> = new Map<string, string>(),
): unknown {
  if (!isRecord(result)) return result

  const maps = answerMaps(original, translated)

  const labelsFor = (key: string): ReadonlyMap<string, string> => {
    const originalQuestion = maps.questions.get(key) ?? key
    return maps.labelsByQuestion.get(originalQuestion) ?? maps.labels
  }

  const restoreValue = (
    value: unknown,
    labels: ReadonlyMap<string, string>,
  ): unknown => {
    return splitAnswer(value, labels)
      .map(segment =>
        segment.kind === 'label'
          ? segment.text
          : freeText.get(segment.text) ?? segment.text,
      )
      .join(', ')
  }

  const out: { [key: string]: unknown } = { ...result }
  out.questions = original

  if (isRecord(result.answers)) {
    out.answers = Object.fromEntries(
      Object.entries(result.answers).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        restoreValue(value, labelsFor(key)),
      ]),
    )
  }

  if (isRecord(result.annotations)) {
    // 引擎的 annotation 值是对象：只翻 notes，preview 和 unanswered 原样保留。
    const restoreAnnotation = (
      value: unknown,
      labels: ReadonlyMap<string, string>,
    ): unknown => {
      if (typeof value === 'string') return restoreValue(value, labels)
      if (!isRecord(value)) return value
      const notes = annotationNotes(value)
      return notes === undefined
        ? { ...value }
        : { ...value, notes: restoreValue(notes, labels) }
    }

    out.annotations = Object.fromEntries(
      Object.entries(result.annotations).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        restoreAnnotation(value, labelsFor(key)),
      ]),
    )
  }

  if (typeof result.response === 'string') {
    out.response = restoreValue(result.response, maps.labels)
  }

  return out
}
