import { expect, test } from 'claude-code/testing'
import { localizeGoalOutput } from './goal'

test('目标设置行只换英文前缀，条件保持原文', {}, async () => {
  expect(localizeGoalOutput('Goal set: 修好登录问题', 'zh')).toBe(
    '目标已设置：修好登录问题',
  )
})

test('目标状态与清除行也换前缀', {}, async () => {
  expect(localizeGoalOutput('Goal active: 修好登录 (3 turns)', 'zh')).toBe(
    '目标进行中：修好登录 (3 turns)',
  )
  expect(localizeGoalOutput('Goal cleared: 修好登录', 'zh')).toBe(
    '目标已清除：修好登录',
  )
})

test('超长提示换整句并保留数字', {}, async () => {
  expect(
    localizeGoalOutput(
      'Goal condition is limited to 4000 characters (got 5000)',
      'zh',
    ),
  ).toBe('目标条件最多 4000 个字符（当前 5000 个）')
})

test('带 stdout 包裹的输出行保留包裹标签', {}, async () => {
  expect(
    localizeGoalOutput(
      '<local-command-stdout>Goal set: 修好登录</local-command-stdout>',
      'zh',
    ),
  ).toBe('<local-command-stdout>目标已设置：修好登录</local-command-stdout>')
})

test('非中文输出语言与非目标行原样返回', {}, async () => {
  expect(localizeGoalOutput('Goal set: 修好登录', 'en')).toBe(
    'Goal set: 修好登录',
  )
  expect(localizeGoalOutput('随便一句话', 'zh')).toBe('随便一句话')
  expect(localizeGoalOutput('Goal set: fix login', 'fr')).toBe(
    'Goal set: fix login',
  )
})
