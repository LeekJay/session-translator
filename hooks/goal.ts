/**
 * `/goal clear` 这类关闭词由引擎自己处理，不是目标条件，没有可翻的内容。
 * 与引擎里的保留词表保持一致。
 */
const CLEAR_WORDS: ReadonlySet<string> = new Set([
  'clear',
  'stop',
  'off',
  'reset',
  'none',
  'cancel',
])

/**
 * `/goal` 的参数是不是一条需要翻译的目标条件：空参数是查询当前状态，
 * 关闭词是清除目标，这两者都不带条件。
 */
export function isGoalCondition(args: string): boolean {
  const text = args.trim()
  if (text.length === 0) return false
  return !CLEAR_WORDS.has(text.toLowerCase())
}

/**
 * 目标条件的译文。作为隐藏 context 附在 `/goal` 输出行之后：模型读到英文，
 * 屏幕上那行、会话记录和目标状态条仍是用户原文。
 */
export function goalConditionContext(translation: string): string {
  return `English translation of the goal condition the person set with /goal:\n${translation}`
}
