export type ProtectedText = {
  readonly text: string
  readonly values: readonly string[]
}

type Range = { start: number; end: number }

type Pattern = { pattern: RegExp; group: number }

const PATTERNS: readonly Pattern[] = [
  { pattern: /(```|~~~)[\s\S]*?\1/g, group: 0 },
  { pattern: /`[^`\n]+`/g, group: 0 },
  { pattern: /<\/?[A-Za-z][^>]*>/g, group: 0 },
  { pattern: /\{\{[\s\S]*?\}\}/g, group: 0 },
  { pattern: /\$\{[^{}]*\}/g, group: 0 },
  { pattern: /https?:\/\/[^\s"'`<>]+/g, group: 0 },
  { pattern: /[A-Za-z]:\\[^\s"'`<>()[\]{}|]+/g, group: 0 },
  { pattern: /(^|[\s(\[{"'`=,;])(\/[^\s"'`<>()[\]{}]+)/g, group: 2 },
  { pattern: /(^|[\s(\[{"'`=,;])(\.\.?\/[^\s"'`<>()[\]{}]+)/g, group: 2 },
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

function placeholder(index: number): string {
  return `@@JXZ_TRANSLATION_${index}@@`
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
  let result = text
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const range = merged[index]
    if (range === undefined) continue
    values[index] = text.slice(range.start, range.end)
    result =
      result.slice(0, range.start) +
      placeholder(index + 1) +
      result.slice(range.end)
  }

  return { text: result, values }
}

export function restoreText(
  text: string,
  values: readonly string[],
): string {
  const seen = new Set<number>()
  const pattern = /@@JXZ_TRANSLATION_(\d+)@@/g

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
    /@@JXZ_TRANSLATION_(\d+)@@/g,
    (whole, digits: string) => values[Number(digits) - 1] ?? whole,
  )
}

export function hasTranslatableProse(protectedText: string): boolean {
  const prose = protectedText.replace(/@@JXZ_TRANSLATION_\d+@@/g, ' ')
  return /\p{L}/u.test(prose)
}
