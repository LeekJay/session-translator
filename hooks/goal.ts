import type { TranslationLanguage } from '../types'

/**
 * `/goal` 的输出行前缀是引擎写死的英文，条件本身是用户原文。
 * 只换前缀，条件和「Last check」等其余内容原样保留。
 */
const ZH_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Goal set: ', '目标已设置：'],
  ['Goal cleared: ', '目标已清除：'],
  ['Goal active: ', '目标进行中：'],
]

const LIMIT_PREFIX = 'Goal condition is limited to '
const LIMIT_TAIL = /^(\d+) characters \(got (\d+)\)$/

const STDOUT_OPEN = '<local-command-stdout>'
const STDOUT_CLOSE = '</local-command-stdout>'

function localizeBody(body: string): string {
  for (const [prefix, replacement] of ZH_PREFIXES) {
    if (body.startsWith(prefix)) {
      return `${replacement}${body.slice(prefix.length)}`
    }
  }

  if (body.startsWith(LIMIT_PREFIX)) {
    const limit = LIMIT_TAIL.exec(body.slice(LIMIT_PREFIX.length))
    if (limit !== null) {
      return `目标条件最多 ${limit[1]} 个字符（当前 ${limit[2]} 个）`
    }
  }

  return body
}

/**
 * `/goal` 的输出行：`Goal set: …`、`Goal active: …`、`Goal cleared: …`，
 * 以及超长时的长度提示。只换英文前缀，条件是用户自己写的原文。
 * 行文本可能带 `<local-command-stdout>` 包裹，原样保留。
 */
export function localizeGoalOutput(
  text: string,
  language: TranslationLanguage,
): string {
  if (language !== 'zh') return text

  const wrapped =
    text.startsWith(STDOUT_OPEN) && text.includes(STDOUT_CLOSE)
      ? text.slice(STDOUT_OPEN.length, text.lastIndexOf(STDOUT_CLOSE))
      : undefined

  if (wrapped === undefined) return localizeBody(text)

  const body = localizeBody(wrapped)
  return body === wrapped
    ? text
    : `${STDOUT_OPEN}${body}${text.slice(text.lastIndexOf(STDOUT_CLOSE))}`
}
