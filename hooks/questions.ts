import type { TranslationLanguage } from '../types'
import { languageName } from './languages'
import { estimateMaxTokens } from './translate'

type Record = { readonly [key: string]: unknown }

export const MAX_HEADER_LENGTH = 12

// 选择对话框系统提示词的版本号。问题翻译的缓存键会带上它，提示词变化时
// 换新键，避免继续复用旧提示词时代持久化的译文。改动问题提示词时必须递增。
export const QUESTIONS_PROMPT_TAG = 'CLAUDE_CODE_SESSION_QUESTION_TRANSLATION_V1'

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
 * 改写后的对话框里，答案键必须唯一：不同题的问题文本不能重名，
 * 同一题内的选项标签也不能重名。任一重名都会让答案错绑到另一个选项，
 * 此时返回 undefined，让引擎画原文对话框。
 */
function hasAmbiguousKeys(rewritten: readonly unknown[]): boolean {
  const questionTexts = new Set<string>()

  for (const question of rewritten) {
    if (!isRecord(question)) continue

    const text = questionTextOf(question)
    if (text !== undefined) {
      if (questionTexts.has(text)) return true
      questionTexts.add(text)
    }

    if (!Array.isArray(question.options)) continue
    const labels = new Set<string>()
    for (const option of question.options) {
      if (!isRecord(option) || !isTranslatable(option.label)) continue
      if (labels.has(option.label)) return true
      labels.add(option.label)
    }
  }

  return false
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
  if (hasAmbiguousKeys(rewritten)) return undefined
  return rewritten
}

export type QuestionsRequest = {
  readonly system: string
  readonly prompt: string
  readonly maxTokens: number
}

function buildRequest(
  texts: readonly string[],
  rules: string,
  openingLine: string,
  detailLines: readonly string[],
): QuestionsRequest {
  const ruleLine =
    rules.trim().length > 0 ? `Additional rules:\n${rules.trim()}` : ''

  const system = [
    openingLine,
    'Return only strict JSON of the shape {"translations":[...]}.',
    'Keep the array the same length and order as the input array.',
    ...detailLines,
    'Never translate code, commands, file paths, URLs, or product names.',
    ruleLine,
  ]
    .filter(line => line.length > 0)
    .join('\n')

  const total = texts.reduce((sum, text) => sum + text.length, 0)
  const maxTokens = estimateMaxTokens(total)

  return {
    system,
    prompt: JSON.stringify(texts),
    maxTokens,
  }
}

// 对话框回复偶尔是截断/未转义的 JSON，或者条数与输入对不上。与回复翻译
// 相同，格式错误时追加这段纠正说明再试一次，不改变缓存键。
export const QUESTIONS_JSON_RETRY_PROMPT =
  'Your previous reply was not a single valid JSON object of the shape {"translations":[...]}. Reply again with only that JSON: the same number of entries in the same order as the input array, escaping every newline as \\n and every double quote as \\".'

export function buildQuestionsRequest(
  texts: readonly string[],
  target: TranslationLanguage,
  rules: string,
): QuestionsRequest {
  return buildRequest(
    texts,
    rules,
    `You translate the interface strings of a multiple-choice dialog into ${languageName(target)}.`,
    [
      'Each entry is user-facing prose: natural, concise, and unambiguous.',
      'Keep headers at most 12 characters and option labels at most 16.',
      'End each question with a question mark.',
    ],
  )
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
  return buildRequest(
    texts,
    rules,
    `You translate answers a person typed into a multiple-choice dialog, into ${languageName(target)}.`,
    [
      'Each entry is one complete answer. Preserve its meaning exactly; do not shorten, merge, or split it.',
    ],
  )
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

/**
 * 同一译名只保留一个原文；对应到不同原文时移除该键并记下歧义，
 * 让这类答案按自由文本处理，避免错绑到另一个选项。
 */
function mapLabel(
  labels: Map<string, string>,
  ambiguous: Set<string>,
  drawn: string,
  source: string,
): void {
  if (ambiguous.has(drawn)) return
  const existing = labels.get(drawn)
  if (existing === undefined || existing === source) {
    labels.set(drawn, source)
  } else {
    labels.delete(drawn)
    ambiguous.add(drawn)
  }
}

type AnswerMaps = {
  readonly questions: Map<string, string>
  readonly labels: Map<string, string>
  readonly labelsByQuestion: Map<string, Map<string, string>>
  readonly multiSelect: Set<string>
}

function answerMaps(
  original: readonly unknown[],
  translated: readonly unknown[],
): AnswerMaps {
  const questions = new Map<string, string>()
  const labels = new Map<string, string>()
  const labelsByQuestion = new Map<string, Map<string, string>>()
  // 只有多选答案由引擎串联并加 JSON 引号；单选答案按原文处理。
  const multiSelect = new Set<string>()
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
    if (
      sourceText !== undefined &&
      isRecord(source) &&
      source.multiSelect === true
    ) {
      multiSelect.add(sourceText)
    }

    if (!isRecord(source) || !isRecord(drawn)) continue
    const sourceOptions = Array.isArray(source.options) ? source.options : []
    const drawnOptions = Array.isArray(drawn.options) ? drawn.options : []
    const options = Math.min(sourceOptions.length, drawnOptions.length)
    const questionLabels = new Map<string, string>()
    const ambiguousQuestionLabels = new Set<string>()
    for (let option = 0; option < options; option += 1) {
      const a = sourceOptions[option]
      const b = drawnOptions[option]
      if (!isRecord(a) || !isRecord(b)) continue
      if (isTranslatable(a.label) && isTranslatable(b.label)) {
        mapLabel(questionLabels, ambiguousQuestionLabels, b.label, a.label)
        mapLabel(labels, ambiguousLabels, b.label, a.label)
      }
    }
    if (sourceText !== undefined) {
      labelsByQuestion.set(sourceText, questionLabels)
    }
  }

  return { questions, labels, labelsByQuestion, multiSelect }
}

function multiSelectAnswer(key: string, maps: AnswerMaps): boolean {
  return maps.multiSelect.has(maps.questions.get(key) ?? key)
}

// 答案按所属问题取标签映射；同一译名在两道题出现时不会互相覆盖。
function labelsFor(
  key: string,
  maps: AnswerMaps,
): ReadonlyMap<string, string> {
  const originalQuestion = maps.questions.get(key) ?? key
  return maps.labelsByQuestion.get(originalQuestion) ?? maps.labels
}

const ANSWER_SEPARATOR = ', '

function answerParts(value: unknown): string[] {
  if (typeof value !== 'string') return []
  // 非多选答案不做 JSON 引号包装，仅按 ", " 拆分并去掉空片段。
  return value
    .split(ANSWER_SEPARATOR)
    .map(part => part.trim())
    .filter(part => part.length > 0)
}

// 找到 JSON 字符串的结束引号；成对反斜杠转义的引号不算结束。
function closingQuoteIndex(text: string): number {
  let escaped = false
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (char === '"') {
      return index
    }
  }
  return -1
}

// 多选答案由引擎用 ", " 连接，含 ", " 或引号的片段会被 JSON 字符串包起来。
// 任何一处不像引擎格式就返回 undefined，让调用方把整串当自由文本。
function encodedAnswerParts(value: string): string[] | undefined {
  const parts: string[] = []
  let rest = value

  while (rest.length > 0) {
    if (!rest.startsWith('"')) {
      const end = rest.indexOf(ANSWER_SEPARATOR)
      if (end < 0) {
        parts.push(rest)
        break
      }
      parts.push(rest.slice(0, end))
      rest = rest.slice(end + ANSWER_SEPARATOR.length)
      continue
    }

    const end = closingQuoteIndex(rest)
    if (end < 0) return undefined

    let decoded: unknown
    try {
      decoded = JSON.parse(rest.slice(0, end + 1))
    } catch {
      return undefined
    }
    if (typeof decoded !== 'string') return undefined

    parts.push(decoded)
    rest = rest.slice(end + 1)
    if (rest.length === 0) break
    if (!rest.startsWith(ANSWER_SEPARATOR)) return undefined
    rest = rest.slice(ANSWER_SEPARATOR.length)
  }

  return parts.filter(part => part.length > 0)
}

// 回写时按引擎规则重新编码：含 ", " 或引号的片段用 JSON 字符串包起来。
function encodeAnswerPart(text: string): string {
  return text.includes(ANSWER_SEPARATOR) || text.includes('"')
    ? JSON.stringify(text)
    : text
}

/**
 * 把一条答案拆成有序的片段：命中的选项标签各占一段。未编码的答案把连续
 * 手输文字并成一段再拼回；引擎编码过的多选答案保留片段边界。
 */
type AnswerSegment =
  | { readonly kind: 'label'; readonly text: string }
  | { readonly kind: 'free'; readonly text: string }

function segmentsFromParts(
  parts: readonly string[],
  labels: ReadonlyMap<string, string>,
  mergeFree: boolean,
): AnswerSegment[] {
  if (!mergeFree) {
    // 引擎编码过的片段边界是真实的：逐片查标签或译文，逐片回写。
    return parts.map(part => {
      const label = labels.get(part)
      return label === undefined
        ? { kind: 'free', text: part }
        : { kind: 'label', text: label }
    })
  }

  const segments: AnswerSegment[] = []
  let free: string[] = []

  const flushFree = (): void => {
    if (free.length === 0) return
    segments.push({ kind: 'free', text: free.join(ANSWER_SEPARATOR) })
    free = []
  }

  for (const part of parts) {
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

type AnswerMode = 'encoded' | 'single' | 'split'

function splitAnswer(
  value: unknown,
  labels: ReadonlyMap<string, string>,
  mode: AnswerMode,
): AnswerSegment[] {
  if (mode === 'encoded' && typeof value === 'string') {
    const parts = encodedAnswerParts(value)
    // 解析失败时保守地回退为整段文本，不做标签映射，也不能抛错。
    if (parts === undefined) return [{ kind: 'free', text: value }]
    return segmentsFromParts(parts, labels, false)
  }
  if (typeof value === 'string') {
    const label = labels.get(value)
    if (label !== undefined) return [{ kind: 'label', text: label }]
    // 单选答案是一整条：未命中整串标签时按整段自由文本处理，
    // 不按 ", " 拆分，避免手输内容里碰巧出现选项标签而被误判。
    if (mode === 'single') {
      return value.trim().length > 0 ? [{ kind: 'free', text: value }] : []
    }
  }
  return segmentsFromParts(answerParts(value), labels, true)
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

  const push = (
    value: unknown,
    labels: ReadonlyMap<string, string>,
    mode: AnswerMode,
  ): void => {
    for (const segment of splitAnswer(value, labels, mode)) {
      if (segment.kind !== 'free') continue
      if (texts.includes(segment.text)) continue
      texts.push(segment.text)
    }
  }

  // annotations 是用户手输的备注原文：不按 ", " 拆分、不做标签映射，
  // 整段（含首尾空格）交给翻译。
  const pushNote = (value: unknown): void => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    if (texts.includes(value)) return
    texts.push(value)
  }

  if (isRecord(result.answers)) {
    for (const [key, value] of Object.entries(result.answers)) {
      const mode: AnswerMode = multiSelectAnswer(key, maps)
        ? 'encoded'
        : 'single'
      push(value, labelsFor(key, maps), mode)
    }
  }
  if (isRecord(result.annotations)) {
    for (const [key, value] of Object.entries(result.annotations)) {
      if (!isRecord(value)) {
        push(value, labelsFor(key, maps), 'split')
        continue
      }
      const notes = annotationNotes(value)
      if (notes !== undefined) pushNote(notes)
    }
  }
  pushNote(result.response)

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

  const restoreValue = (
    value: unknown,
    labels: ReadonlyMap<string, string>,
    mode: AnswerMode,
  ): unknown => {
    if (typeof value !== 'string') return value
    return splitAnswer(value, labels, mode)
      .map(segment => {
        const text =
          segment.kind === 'label'
            ? segment.text
            : freeText.get(segment.text) ?? segment.text
        return mode === 'encoded' ? encodeAnswerPart(text) : text
      })
      .join(ANSWER_SEPARATOR)
  }

  // 备注是整段原文：只用译文映射，不参与标签识别，也不重新编码。
  const restoreNote = (value: string): string => freeText.get(value) ?? value

  const out: { [key: string]: unknown } = { ...result }
  out.questions = original

  if (isRecord(result.answers)) {
    out.answers = Object.fromEntries(
      Object.entries(result.answers).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        restoreValue(
          value,
          labelsFor(key, maps),
          multiSelectAnswer(key, maps) ? 'encoded' : 'single',
        ),
      ]),
    )
  }

  if (isRecord(result.annotations)) {
    // 引擎的 annotation 值是对象：只翻 notes，preview 和 unanswered 原样保留。
    const restoreAnnotation = (
      value: unknown,
      labels: ReadonlyMap<string, string>,
    ): unknown => {
      if (typeof value === 'string') return restoreValue(value, labels, 'split')
      if (!isRecord(value)) return value
      const notes = annotationNotes(value)
      return notes === undefined
        ? { ...value }
        : { ...value, notes: restoreNote(notes) }
    }

    out.annotations = Object.fromEntries(
      Object.entries(result.annotations).map(([key, value]) => [
        maps.questions.get(key) ?? key,
        restoreAnnotation(value, labelsFor(key, maps)),
      ]),
    )
  }

  if (typeof result.response === 'string') {
    out.response = restoreNote(result.response)
  }

  return out
}
