export type ProtectedText = {
  readonly text: string
  readonly values: readonly string[]
}

type Range = { start: number; end: number }

type Pattern = { pattern: RegExp; group: number }

const PATTERNS: readonly Pattern[] = [
  {
    pattern: /(?<![`~])(`{3,}|~{3,})(?![`~])[\s\S]*?\n[^\S\n]*\1(?![`~])/g,
    group: 0,
  },
  // 反引号必须成对且长度相同。否则围栏结尾的第三个反引号会被当成
  // 行内代码起点，把围栏与后面行内代码之间的正文一起吞进受保护片段。
  { pattern: /(?<!`)(`+)(?!`)[^`\n]+?\1(?!`)/g, group: 0 },
  { pattern: /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?\/?>/g, group: 0 },
  { pattern: /\{\{[\s\S]*?\}\}/g, group: 0 },
  { pattern: /\$\{[^{}]*\}/g, group: 0 },
  { pattern: /https?:\/\/[^\s"'`<>]+/g, group: 0 },
  { pattern: /[A-Za-z]:\\[^\s"'`<>()[\]{}|]+/g, group: 0 },
  { pattern: /(^|[\s(\[{"'`=,;])(\/[^\s"'`<>()[\]{}]+)/g, group: 2 },
  { pattern: /(^|[\s(\[{"'`=,;])(\.\.?\/[^\s"'`<>()[\]{}]+)/g, group: 2 },
  {
    pattern:
      /(^|[\s(\[{"'`=,;])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)/g,
    group: 2,
  },
  { pattern: /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g, group: 0 },
  { pattern: /\b[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\b/g, group: 0 },
  { pattern: /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g, group: 0 },
  { pattern: /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g, group: 0 },
  { pattern: /\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, group: 0 },
]

function collect(text: string, { pattern, group }: Pattern): Range[] {
  const ranges: Range[] = []
  pattern.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const value = match[group]
    if (value !== undefined && value.length > 0) {
      const offset = match[0].indexOf(value)
      ranges.push({
        start: match.index + offset,
        end: match.index + offset + value.length,
      })
    }
    if (match[0].length === 0) pattern.lastIndex += 1
  }

  return ranges
}

export const PLACEHOLDER_PATTERN = /@@ST_KEEP_(\d+)@@/g

function placeholder(index: number): string {
  return `@@ST_KEEP_${index}@@`
}

export function protectText(text: string): ProtectedText {
  const ranges: Range[] = []
  for (const entry of PATTERNS) {
    ranges.push(...collect(text, entry))
  }

  ranges.sort((a, b) => a.start - b.start || b.end - a.end)

  const merged: Range[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last !== undefined && range.start < last.end) {
      if (range.end > last.end) last.end = range.end
    } else {
      merged.push({ start: range.start, end: range.end })
    }
  }

  const values: string[] = []
  const parts: string[] = []
  let cursor = 0
  for (let index = 0; index < merged.length; index += 1) {
    const range = merged[index]
    if (range === undefined) continue
    parts.push(text.slice(cursor, range.start), placeholder(index + 1))
    values.push(text.slice(range.start, range.end))
    cursor = range.end
  }
  parts.push(text.slice(cursor))

  return { text: parts.join(''), values }
}

export function restoreText(
  text: string,
  values: readonly string[],
): string {
  const seen = new Set<number>()
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const index = Number(match[1])
    if (!Number.isInteger(index) || index < 1 || index > values.length) {
      throw new Error(`unknown placeholder ${match[0]}`)
    }
    if (seen.has(index)) {
      throw new Error(`duplicate placeholder ${match[0]}`)
    }
    seen.add(index)
  }

  if (seen.size !== values.length) {
    throw new Error('a placeholder is missing')
  }

  return text.replace(
    PLACEHOLDER_PATTERN,
    (whole, digits: string) => values[Number(digits) - 1] ?? whole,
  )
}

export function hasTranslatableProse(protectedText: string): boolean {
  const prose = protectedText.replace(PLACEHOLDER_PATTERN, ' ')
  return /\p{L}/u.test(prose)
}
