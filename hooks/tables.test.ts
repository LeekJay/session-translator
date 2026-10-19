import { expect, test } from 'claude-code/testing'
import { containsTable, fitTables } from './tables'

test('识别表格但不识别代码围栏里的竖线', {}, async () => {
  expect(containsTable('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(true)
  expect(containsTable('```\n| A | B |\n|---|---|\n| 1 | 2 |\n```')).toBe(
    false,
  )
})

test('窄中文表格保持表格', {}, async () => {
  const text = '| 甲 | 乙 |\n|---|---|\n| 一 | 二 |'
  expect(fitTables(text, 80)).toBe(text)
})

test('宽中文表格转成列表', {}, async () => {
  const note = '生成的技能副本同步（英文翻译）与该功能无关'.repeat(3)
  const text = `| 区域 | 说明 |\n|---|---|\n| 客户端 | ${note} |`
  const output = fitTables(text, 40)

  expect(output).toContain('- **区域**: 客户端')
  expect(output).toContain('**说明**:')
  expect(output).toContain(note)
  expect(output.includes('|---|')).toBe(false)
})

test('宽英文表格保持表格', {}, async () => {
  const note = 'long english notes '.repeat(20)
  const text = `| Area | Notes |\n|---|---|\n| client | ${note} |`
  expect(fitTables(text, 40)).toBe(text)
})

test('没有视口宽度时不改文本', {}, async () => {
  const text = '| 甲 | 乙 |\n|---|---|\n| 一 | 二 |'
  expect(fitTables(text, undefined)).toBe(text)
})

test('代码围栏里的竖线不当作表格', {}, async () => {
  const note = '生成的技能副本同步（英文翻译）与该功能无关'.repeat(3)
  const text = `\`\`\`\n| 区域 | 说明 |\n|---|---|\n| 客户端 | ${note} |\n\`\`\``
  expect(fitTables(text, 10)).toBe(text)
})

test('只转换超过视口的那张表', {}, async () => {
  const note = '生成的技能副本同步（英文翻译）与该功能无关'.repeat(3)
  const text = [
    '| 甲 | 乙 |',
    '|---|---|',
    '| 一 | 二 |',
    '',
    '| 区域 | 说明 |',
    '|---|---|',
    `| 客户端 | ${note} |`,
  ].join('\n')
  const output = fitTables(text, 40)

  expect(output.split('|---|---|').length - 1).toBe(1)
  expect(output).toContain('| 甲 | 乙 |')
  expect(output).toContain('- **区域**: 客户端')
})
