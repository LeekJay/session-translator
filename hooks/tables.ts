const FENCE = /^\s*(?:```|~~~)/
const WIDE_MARGIN = 4

function isRow(line: string): boolean {
  return line.trim().startsWith('|')
}

function splitRow(line: string): string[] {
  let text = line.trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|')) text = text.slice(0, -1)
  return text.split(/(?<!\\)\|/).map(cell => cell.trim())
}

function isSeparator(line: string): boolean {
  if (!isRow(line)) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function wideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += wideChar(char) ? 2 : 1
  return width
}

function visibleWidth(cell: string): number {
  return displayWidth(cell.replace(/`/g, '').replace(/\*\*/g, ''))
}

function hasWideText(cells: readonly string[]): boolean {
  return cells.some(cell => displayWidth(cell) > [...cell].length)
}

function renderedWidth(header: readonly string[], rows: readonly string[][]): number {
  const columnCount = Math.max(header.length, ...rows.map(row => row.length))
  let total = 0
  for (let column = 0; column < columnCount; column += 1) {
    let max = 0
    for (const row of [header, ...rows]) {
      max = Math.max(max, visibleWidth(row[column] ?? ''))
    }
    total += max
  }
  return total + 3 * (columnCount - 1) + 4
}

function toBullets(
  header: readonly string[],
  rows: readonly string[][],
): string[] {
  const lines: string[] = []
  for (const row of rows) {
    const parts: string[] = []
    row.forEach((cell, index) => {
      if (cell.length === 0) return
      const label = header[index]?.replace(/[*`]/g, '').trim() ?? ''
      parts.push(label.length > 0 ? `**${label}**: ${cell}` : cell)
    })
    if (parts.length > 0) lines.push(`- ${parts.join(' · ')}`)
  }
  return lines
}

export function containsTable(text: string): boolean {
  const lines = text.split('\n')
  let inFence = false
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? ''
    if (FENCE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && isRow(line) && isSeparator(lines[index + 1] ?? '')) {
      return true
    }
  }
  return false
}

// 终端表格不换行；含宽字符的长表格会被逐行裁切，滚动时错位。
// 超过视口宽度的中文表格改画成列表，交给正文换行器处理。
export function fitTables(text: string, columns: number | undefined): string {
  if (columns === undefined || columns <= 0) return text

  const lines = text.split('\n')
  const output: string[] = []
  let inFence = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (FENCE.test(line)) {
      inFence = !inFence
      output.push(line)
      index += 1
      continue
    }

    if (
      inFence ||
      !isRow(line) ||
      !isSeparator(lines[index + 1] ?? '')
    ) {
      output.push(line)
      index += 1
      continue
    }

    const header = splitRow(line)
    const rows: string[][] = []
    let end = index + 2
    while (end < lines.length && isRow(lines[end] ?? '')) {
      rows.push(splitRow(lines[end] ?? ''))
      end += 1
    }

    const cells = [...header, ...rows.flat()]
    const tooWide = renderedWidth(header, rows) + WIDE_MARGIN > columns
    if (rows.length > 0 && tooWide && hasWideText(cells)) {
      output.push(...toBullets(header, rows))
    } else {
      output.push(...lines.slice(index, end))
    }
    index = end
  }

  return output.join('\n')
}
