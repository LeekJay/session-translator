import { expect, test } from 'claude-code/testing'
import { goalConditionOf, replaceGoalCondition } from './goal'

const ACK =
  'A session-scoped Stop hook is now active with condition: "修好登录问题". Briefly acknowledge the goal, then immediately start (or continue) working toward it.'

test('从目标提示行里取出条件', {}, async () => {
  expect(goalConditionOf(ACK)).toBe('修好登录问题')
})

test('不是目标提示行时返回 undefined', {}, async () => {
  expect(goalConditionOf('随便一句话')).toBeUndefined()
  expect(
    goalConditionOf('A session-scoped Stop hook is now active with condition: ""'),
  ).toBeUndefined()
})

test('只替换引号里的条件，引擎文案原样保留', {}, async () => {
  expect(replaceGoalCondition(ACK, 'Fix the login problem')).toBe(
    ACK.replace('修好登录问题', 'Fix the login problem'),
  )
})

test('条件里含引号或换行时按位置替换', {}, async () => {
  const text = 'A session-scoped Stop hook is now active with condition: "他说"好"". tail'
  expect(goalConditionOf(text)).toBe('他说"好"')
  expect(replaceGoalCondition(text, 'He said "ok"')).toBe(
    'A session-scoped Stop hook is now active with condition: "He said "ok"". tail',
  )
})

test('不是目标提示行的文本原样返回', {}, async () => {
  expect(replaceGoalCondition('随便一句话', 'x')).toBe('随便一句话')
})
