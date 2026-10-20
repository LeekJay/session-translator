/**
 * `/goal` 设置目标时，引擎追加一条只给模型看的 meta 行：
 * `A session-scoped Stop hook is now active with condition: "<条件>". …`
 * 条件是用户原文。这里只换引号里的条件，其余引擎文案原样保留。
 */
const CONDITION_PREFIX =
  'A session-scoped Stop hook is now active with condition: "'

const CONDITION_TAIL = '".'

/**
 * 从这条 meta 行里取出目标条件；不是这条行就返回 undefined。
 */
export function goalConditionOf(text: string): string | undefined {
  if (!text.startsWith(CONDITION_PREFIX)) return undefined
  const end = text.indexOf(CONDITION_TAIL, CONDITION_PREFIX.length)
  if (end === -1) return undefined
  const condition = text.slice(CONDITION_PREFIX.length, end)
  return condition.length > 0 ? condition : undefined
}

/**
 * 一条 row 的正文：单一字符串块，或若干 text block 拼起来。
 * 这条提示行引擎只放一个 text block；取不到就放弃改写。
 */
export function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content.map(block =>
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: string }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
      ? ((block as { text: string }).text)
      : undefined,
  )
  if (texts.length === 0 || texts.some(text => text === undefined)) {
    return undefined
  }
  return texts.join('\n')
}

/**
 * 把 meta 行里的条件换成译文。行文本可能被拆成多个 text block，逐个处理。
 */
export function replaceGoalCondition(text: string, translation: string): string {
  const condition = goalConditionOf(text)
  if (condition === undefined) return text
  const start = CONDITION_PREFIX.length
  return `${text.slice(0, start)}${translation}${text.slice(start + condition.length)}`
}
